//! The build thread's side of the engine: makes parcels of the page's batches and frees those that come back, and
//! holds the pool of stored sounds. It keeps its own record of the nodes and never reads the audio thread's.

mod record;

use std::collections::{BTreeMap, HashSet};
use std::mem;

use flatbuffers::Vector;

use engine_plugins::{SampleRate, catalog};

use crate::graph::{Nodes, Table};
use crate::handle::{NodeHandle, PatternCell, PatternHandle};
use crate::handoff::{Batch, BuildEnd, Edit, Parcel};
use crate::node::{Node, page_param, page_sample};
use crate::notes::note_velocity;
use crate::pool::SamplePool;
use crate::schema::{self, DeviceEdit, Rejection};
use crate::sequencer::{Arrangement, Clip, Note, Pattern, Patterns};
use crate::strip::page_strip_param;
use record::{Record, Removal};

/// A new engine's tables of cells and of exits for removed nodes, and of patterns; they double as needed.
pub(crate) const FIRST_CELLS: usize = 16;
pub(crate) const FIRST_EXITS: usize = 16;
pub(crate) const FIRST_PATTERN_CELLS: usize = 16;

/// What the build thread knows of the patterns and clips heard once every parcel sent is applied.
struct Heard {
    /// The live patterns by cell: each one's handle, and every node its notes name, live or not.
    patterns: BTreeMap<PatternCell, (PatternHandle, HashSet<NodeHandle>)>,
    /// Every pattern the clips name, live or not; none without clips.
    clips: HashSet<PatternHandle>,
    /// The audio thread's pattern table, once the parcels sent are applied.
    cells: usize,
    /// The batch sent a pattern or clips, or removed a node or a pattern they name, so they may now name one that
    /// isn't live.
    unchecked: bool,
}

impl Heard {
    fn new() -> Self {
        Self {
            patterns: BTreeMap::new(),
            clips: HashSet::new(),
            cells: FIRST_PATTERN_CELLS,
            unchecked: false,
        }
    }

    fn is_live(&self, pattern: PatternHandle) -> bool {
        self.patterns
            .get(&pattern.cell())
            .is_some_and(|(made, _)| *made == pattern)
    }

    /// Whether a pattern names a node that isn't live, or a clip a pattern that isn't: one refusal each, after a batch
    /// that may have made it so.
    fn check(&mut self, record: &Record) -> impl Iterator<Item = Edit> + use<> {
        let unchecked = mem::take(&mut self.unchecked);
        let nodes = unchecked
            && self
                .patterns
                .values()
                .any(|(_, nodes)| nodes.iter().any(|&node| !record.has_live(node)));
        let clips = unchecked && self.clips.iter().any(|&pattern| !self.is_live(pattern));
        [nodes, clips]
            .into_iter()
            .filter(|&refused| refused)
            .map(|_| Edit::Refused(Rejection::UnknownTarget))
    }
}

pub struct Builder {
    sample_rate: SampleRate,
    handoff: BuildEnd,
    record: Record,
    heard: Heard,
    /// Not part of a session: a reset leaves it.
    samples: SamplePool,
}

/// A note of no length is refused, as one with a key or velocity no note has.
fn pattern_note(note: &schema::PatternNote) -> Result<Note, Rejection> {
    let velocity = note_velocity(note.key(), note.velocity())?;
    if note.length() == 0 {
        return Err(Rejection::InvalidValue);
    }
    Ok(Note {
        tick: note.tick(),
        node: NodeHandle::new(note.node()),
        key: note.key(),
        velocity,
        length: note.length(),
    })
}

impl Builder {
    pub(crate) fn new(sample_rate: SampleRate, handoff: BuildEnd) -> Self {
        Self {
            sample_rate,
            handoff,
            record: Record::new(FIRST_CELLS, FIRST_EXITS),
            heard: Heard::new(),
            samples: SamplePool::new(sample_rate),
        }
    }

    pub fn samples(&mut self) -> &mut SamplePool {
        &mut self.samples
    }

    /// Every batch makes a parcel, refusals and all: its marker in the ring waits for it.
    pub fn build(&mut self, batch: u32, bytes: &[u8]) {
        let batch = Batch::new(batch);
        let sizes = (self.record.cells(), self.record.exits());
        let pattern_cells = self.heard.cells;
        let (mut edits, mut let_go) = (Vec::new(), Vec::new());
        match schema::root_as_device_batch(bytes) {
            Ok(device_batch) => {
                for edit in device_batch.edits().into_iter().flatten() {
                    if let Err(reason) = self.add(&mut edits, &mut let_go, batch, edit) {
                        edits.push(Edit::Refused(reason));
                    }
                }
            }
            Err(_) => edits.push(Edit::Refused(Rejection::Malformed)),
        }
        // However many the batch names, and however often, the audio thread goes through the held notes once.
        let_go.sort_unstable();
        let_go.dedup();
        if !let_go.is_empty() {
            edits.push(Edit::LetGo(let_go.into_boxed_slice()));
        }
        // After the whole batch, so a pattern may come before the nodes it names, and clips before their patterns.
        edits.extend(self.heard.check(&self.record));
        if let Some(order) = self.record.take_changes() {
            edits.push(Edit::Order(order));
        }
        // Once, before anything the parcel puts in them: the audio thread moves every node over each time.
        let grown = [
            (Table::Cells, sizes.0, self.record.cells()),
            (Table::Exits, sizes.1, self.record.exits()),
        ]
        .into_iter()
        .filter(|&(_, before, after)| after > before)
        .map(|(table, _, len)| Edit::Grow {
            table,
            nodes: Nodes::new(len),
        });
        let patterns_grown = (self.heard.cells > pattern_cells)
            .then(|| Edit::GrowPatterns(Patterns::new(self.heard.cells)));
        let edits = grown.chain(patterns_grown).chain(edits).collect();
        let holds = self.record.take_holds();
        self.handoff.send(Parcel {
            batch,
            edits,
            holds,
        });
    }

    /// Frees the parcels that came back, and forgets what they faded out; returns how many aren't back yet.
    pub fn collect(&mut self) -> usize {
        let record = &mut self.record;
        let mut came_back = false;
        let out = self.handoff.collect(|parcel| {
            came_back = true;
            if parcel.holds {
                record.finish(parcel.batch);
            }
        });
        // The nodes they freed may have held the last references to sounds that never came.
        if came_back {
            self.samples.forget_unreferred();
        }
        out
    }

    /// The nodes whose notes the batch lets go of go into `let_go`, for one edit at its end.
    fn add(
        &mut self,
        edits: &mut Vec<Edit>,
        let_go: &mut Vec<NodeHandle>,
        batch: Batch,
        edit: schema::Edit<'_>,
    ) -> Result<(), Rejection> {
        match edit.edit_type() {
            DeviceEdit::Reset => {
                let reset = edit.edit_as_reset().ok_or(Rejection::Malformed)?;
                edits.push(Edit::Reset(reset.epoch()));
                for handle in self.record.live_handles() {
                    self.remove(edits, batch, handle)?;
                }
                let heard = &mut self.heard;
                edits.extend(mem::take(&mut heard.patterns).into_keys().map(|cell| {
                    Edit::Pattern {
                        cell,
                        pattern: None,
                    }
                }));
                if !mem::take(&mut heard.clips).is_empty() {
                    edits.push(Edit::Arrangement(Arrangement::default()));
                }
                Ok(())
            }
            DeviceEdit::CreateNode => {
                let create = edit.edit_as_create_node().ok_or(Rejection::Malformed)?;
                self.create_node(edits, create)
            }
            DeviceEdit::SetOutput => {
                let output = edit.edit_as_set_output().ok_or(Rejection::Malformed)?;
                self.record
                    .set_output(NodeHandle::new(output.node()), batch)
            }
            DeviceEdit::Connect => {
                let connect = edit.edit_as_connect().ok_or(Rejection::Malformed)?;
                let (from, to) = (connect.from(), connect.to());
                self.record
                    .connect(NodeHandle::new(from), NodeHandle::new(to))
            }
            DeviceEdit::DestroyNode => {
                let destroy = edit.edit_as_destroy_node().ok_or(Rejection::Malformed)?;
                self.remove(edits, batch, NodeHandle::new(destroy.node()))
            }
            DeviceEdit::SetPattern => {
                let set = edit.edit_as_set_pattern().ok_or(Rejection::Malformed)?;
                self.set_pattern(edits, set)
            }
            DeviceEdit::DestroyPattern => {
                let destroy = edit.edit_as_destroy_pattern().ok_or(Rejection::Malformed)?;
                let pattern = PatternHandle::new(destroy.pattern());
                let heard = &mut self.heard;
                if !heard.is_live(pattern) {
                    return Err(Rejection::UnknownTarget);
                }
                heard.patterns.remove(&pattern.cell());
                heard.unchecked |= heard.clips.contains(&pattern);
                edits.push(Edit::Pattern {
                    cell: pattern.cell(),
                    pattern: None,
                });
                Ok(())
            }
            DeviceEdit::SetClips => {
                let set = edit.edit_as_set_clips().ok_or(Rejection::Malformed)?;
                self.set_clips(edits, set);
                Ok(())
            }
            DeviceEdit::CreateInsert => {
                let create = edit.edit_as_create_insert().ok_or(Rejection::Malformed)?;
                let handle = self.free_handle(create.node())?;
                let mut node = Node::insert(self.sample_rate, handle, create.metered());
                let refused = set_each(create.strip(), |param, value| {
                    node.set_strip_param(page_strip_param(param)?, value)
                });
                self.place(edits, node);
                edits.extend(refused.into_iter().map(Edit::Refused));
                Ok(())
            }
            DeviceEdit::Disconnect => {
                let disconnect = edit.edit_as_disconnect().ok_or(Rejection::Malformed)?;
                let (from, to) = (disconnect.from(), disconnect.to());
                self.record
                    .disconnect(NodeHandle::new(from), NodeHandle::new(to), batch)
            }
            DeviceEdit::LetGoOfNotes => {
                let table = edit.edit_as_let_go_of_notes().ok_or(Rejection::Malformed)?;
                let node = NodeHandle::new(table.node());
                if !self.record.has_live(node) {
                    return Err(Rejection::UnknownTarget);
                }
                let_go.push(node);
                Ok(())
            }
            DeviceEdit::PanicBuild => {
                let panic = edit.edit_as_panic_build().ok_or(Rejection::Malformed)?;
                panic!("PanicBuild {}", panic.code())
            }
            DeviceEdit::HangBuild => {
                edit.edit_as_hang_build().ok_or(Rejection::Malformed)?;
                crate::hang()
            }
            DeviceEdit::NONE => Err(Rejection::Malformed),
            _ => Err(Rejection::UnknownCommand),
        }
    }

    fn create_node(
        &mut self,
        edits: &mut Vec<Edit>,
        create: schema::CreateNode<'_>,
    ) -> Result<(), Rejection> {
        let handle = self.free_handle(create.node())?;
        let entry =
            catalog::find(create.plugin(), create.version()).ok_or(Rejection::UnknownPlugin)?;
        let mut node = Node::new(entry, self.sample_rate, handle);
        // One refused value leaves its parameter at the default, and one refused sample silent; refusing the node would
        // refuse its output and knobs too.
        let mut refused = set_each(create.params(), |param, value| {
            node.set_param(page_param(param)?, value)
        });
        refused.extend(set_each(create.strip(), |param, value| {
            node.set_strip_param(page_strip_param(param)?, value)
        }));
        let samples = &mut self.samples;
        refused.extend(create.samples().into_iter().flatten().filter_map(|sound| {
            let hash = sound.hash().into();
            page_sample(sound.sample())
                .and_then(|number| node.set_sample(number, || samples.refer(hash)))
                .err()
        }));
        self.place(edits, node);
        edits.extend(refused.into_iter().map(Edit::Refused));
        Ok(())
    }

    /// A handle a new node can take: not 0, in a cell no live node holds.
    fn free_handle(&self, node: u32) -> Result<NodeHandle, Rejection> {
        let handle = NodeHandle::new(node);
        if handle.is_none() {
            return Err(Rejection::InvalidHandle);
        }
        if self.record.is_taken(handle.cell()) {
            return Err(Rejection::CellTaken);
        }
        Ok(handle)
    }

    /// Into its cell, hearing nothing yet.
    fn place(&mut self, edits: &mut Vec<Edit>, node: Node) {
        let handle = node.handle();
        let cell = handle.cell();
        self.record.make_room(cell);
        self.record.add(handle);
        edits.push(Edit::CreateNode {
            cell,
            node: Some(Box::new(node)),
        });
    }

    /// Made in a free cell, or in place of the pattern of the same handle. Notes with values no note can have are dropped
    /// under one refusal for the edit; the rest play.
    fn set_pattern(
        &mut self,
        edits: &mut Vec<Edit>,
        set: schema::SetPattern<'_>,
    ) -> Result<(), Rejection> {
        let handle = PatternHandle::new(set.pattern());
        if handle.is_none() {
            return Err(Rejection::InvalidHandle);
        }
        let cell = handle.cell();
        let heard = &mut self.heard;
        if heard
            .patterns
            .get(&cell)
            .is_some_and(|(made, _)| *made != handle)
        {
            return Err(Rejection::CellTaken);
        }
        let mut refused = None;
        let notes: Vec<_> = set
            .notes()
            .into_iter()
            .flatten()
            .filter_map(|note| match pattern_note(note) {
                Ok(note) => Some(note),
                Err(reason) => {
                    refused.get_or_insert(reason);
                    None
                }
            })
            .collect();
        heard.cells = heard.cells.max((cell.index() + 1).next_power_of_two());
        heard
            .patterns
            .insert(cell, (handle, notes.iter().map(|note| note.node).collect()));
        heard.unchecked = true;
        edits.push(Edit::Pattern {
            cell,
            pattern: Some((handle, Pattern::new(notes))),
        });
        edits.extend(refused.map(Edit::Refused));
        Ok(())
    }

    /// A clip of no length, or of no period, is dropped under one refusal for the edit; the rest play.
    fn set_clips(&mut self, edits: &mut Vec<Edit>, set: schema::SetClips<'_>) {
        let mut refused = None;
        let clips: Vec<_> = set
            .clips()
            .into_iter()
            .flatten()
            .filter_map(|clip| {
                let (Some(past), true) = (clip.length().checked_sub(1), clip.period() > 0) else {
                    refused = Some(Rejection::InvalidValue);
                    return None;
                };
                Some(Clip {
                    tick: clip.tick(),
                    last: clip.tick().saturating_add(past),
                    period: clip.period(),
                    offset: clip.offset() % clip.period(),
                    pattern: PatternHandle::new(clip.pattern()),
                })
            })
            .collect();
        let heard = &mut self.heard;
        heard.clips = clips.iter().map(|clip| clip.pattern).collect();
        heard.unchecked = true;
        edits.push(Edit::Arrangement(Arrangement::new(clips)));
        edits.extend(refused.map(Edit::Refused));
    }

    fn remove(
        &mut self,
        edits: &mut Vec<Edit>,
        batch: Batch,
        handle: NodeHandle,
    ) -> Result<(), Rejection> {
        let Removal { cell, exit } = self.record.remove(handle, batch)?;
        let heard = &mut self.heard;
        heard.unchecked |= heard
            .patterns
            .values()
            .any(|(_, nodes)| nodes.contains(&handle));
        edits.push(Edit::Remove {
            cell,
            exit,
            node: None,
        });
        Ok(())
    }
}

/// A node's initial values, before its first block; what is refused stays at its default.
fn set_each(
    values: Option<Vector<'_, schema::ParamValue>>,
    mut set: impl FnMut(u32, f32) -> Result<(), Rejection>,
) -> Vec<Rejection> {
    values
        .into_iter()
        .flatten()
        .filter_map(|value| set(value.param(), value.value()).err())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use engine_plugins::catalog::tone;
    use flatbuffers::{FlatBufferBuilder, UnionWIPOffset, WIPOffset};

    use super::*;
    use crate::graph::{Exit, Order, Seat};
    use crate::handoff::{self, Arrival, AudioEnd};
    use crate::pool::Hash;
    use crate::schema::{
        Connect, ConnectArgs, CreateInsert, CreateInsertArgs, CreateNodeArgs, DestroyNode,
        DestroyNodeArgs, DeviceBatch, DeviceBatchArgs, Disconnect, DisconnectArgs, EditArgs,
        HangBuild, HangBuildArgs, LetGoOfNotes, LetGoOfNotesArgs, PanicBuild, PanicBuildArgs,
        ParamValue, PatternNote, Reset, ResetArgs, SampleSound, SetOutput, SetOutputArgs,
        SetPatternArgs,
    };
    use crate::schema::{DestroyPattern, DestroyPatternArgs, SetClips, SetClipsArgs};
    use crate::strip::{PAN_NUMBER, VOLUME_NUMBER};
    use crate::testing::{SAMPLE_RATE, cell};

    /// An edit as the page writes it.
    #[derive(Clone, Copy)]
    pub enum Spec<'a> {
        Reset(u32),
        CreateNode {
            node: u32,
            plugin: u32,
            version: u32,
            params: &'a [(u32, f32)],
            samples: &'a [(u32, Hash)],
            strip: &'a [(u32, f32)],
        },
        SetOutput(u32),
        Connect {
            from: u32,
            to: u32,
        },
        DestroyNode(u32),
        /// The pattern's handle and its notes.
        SetPattern(u32, &'a [Played]),
        DestroyPattern(u32),
        SetClips(&'a [Placed]),
        /// The node and its strip's initial values.
        CreateInsert(u32, &'a [(u32, f32)]),
        /// The node and its strip's initial values, with a meter.
        MeteredInsert(u32, &'a [(u32, f32)]),
        Disconnect {
            from: u32,
            to: u32,
        },
        PanicBuild(u32),
        HangBuild(u32),
        LetGoOfNotes(u32),
        /// An empty table of this kind; none of the page's.
        Bare(DeviceEdit),
        /// No edit at all.
        Missing,
    }

    /// A note of a pattern: tick, node, key, velocity and length.
    pub type Played = (u32, u32, u8, f32, u32);

    /// A clip: tick, length, period, offset and pattern.
    pub type Placed = (u32, u32, u32, u32, u32);

    /// The test tone with initial values.
    pub fn tone_node(node: u32, params: &[(u32, f32)]) -> Spec<'_> {
        Spec::CreateNode {
            node,
            plugin: tone::DESCRIPTION.id,
            version: tone::DESCRIPTION.version,
            params,
            samples: &[],
            strip: &[],
        }
    }

    pub fn connect(from: u32, to: u32) -> Spec<'static> {
        Spec::Connect { from, to }
    }

    pub fn disconnect(from: u32, to: u32) -> Spec<'static> {
        Spec::Disconnect { from, to }
    }

    /// The handle of a cell in its `generation`.
    pub const fn handle(generation: u32, cell: u32) -> u32 {
        generation << 16 | cell
    }

    pub fn batch(specs: &[Spec<'_>]) -> Vec<u8> {
        let mut fbb = FlatBufferBuilder::new();
        let edits: Vec<_> = specs
            .iter()
            .map(|&spec| {
                let args = match spec {
                    Spec::Missing => EditArgs::default(),
                    spec => {
                        let (edit_type, edit) = table(&mut fbb, spec);
                        EditArgs {
                            edit_type,
                            edit: Some(edit),
                        }
                    }
                };
                schema::Edit::create(&mut fbb, &args)
            })
            .collect();
        let edits = fbb.create_vector(&edits);
        let root = DeviceBatch::create(&mut fbb, &DeviceBatchArgs { edits: Some(edits) });
        fbb.finish(root, None);
        fbb.finished_data().to_vec()
    }

    fn param_values<'a>(
        fbb: &mut FlatBufferBuilder<'a>,
        values: &[(u32, f32)],
    ) -> WIPOffset<Vector<'a, ParamValue>> {
        let values: Vec<_> = values.iter().map(|&(p, v)| ParamValue::new(p, v)).collect();
        fbb.create_vector(&values)
    }

    #[expect(clippy::too_many_lines, reason = "one arm for each kind of edit")]
    fn table(
        fbb: &mut FlatBufferBuilder<'_>,
        spec: Spec<'_>,
    ) -> (DeviceEdit, WIPOffset<UnionWIPOffset>) {
        match spec {
            Spec::Reset(epoch) => (
                DeviceEdit::Reset,
                Reset::create(fbb, &ResetArgs { epoch }).as_union_value(),
            ),
            Spec::CreateNode {
                node,
                plugin,
                version,
                params,
                samples,
                strip,
            } => {
                let params = Some(param_values(fbb, params));
                let strip = Some(param_values(fbb, strip));
                let sounds: Vec<_> = samples
                    .iter()
                    .map(|(sample, hash)| SampleSound::new(*sample, hash))
                    .collect();
                let samples = Some(fbb.create_vector(&sounds));
                let args = CreateNodeArgs {
                    node,
                    plugin,
                    version,
                    params,
                    samples,
                    strip,
                };
                let create = schema::CreateNode::create(fbb, &args);
                (DeviceEdit::CreateNode, create.as_union_value())
            }
            Spec::SetOutput(node) => (
                DeviceEdit::SetOutput,
                SetOutput::create(fbb, &SetOutputArgs { node }).as_union_value(),
            ),
            Spec::Connect { from, to } => (
                DeviceEdit::Connect,
                Connect::create(fbb, &ConnectArgs { from, to }).as_union_value(),
            ),
            Spec::DestroyNode(node) => (
                DeviceEdit::DestroyNode,
                DestroyNode::create(fbb, &DestroyNodeArgs { node }).as_union_value(),
            ),
            Spec::SetPattern(pattern, notes) => {
                let notes: Vec<_> = notes
                    .iter()
                    .map(|&(tick, node, key, velocity, length)| {
                        PatternNote::new(tick, node, key, velocity, length)
                    })
                    .collect();
                let notes = Some(fbb.create_vector(&notes));
                let set = schema::SetPattern::create(fbb, &SetPatternArgs { pattern, notes });
                (DeviceEdit::SetPattern, set.as_union_value())
            }
            Spec::DestroyPattern(pattern) => (
                DeviceEdit::DestroyPattern,
                DestroyPattern::create(fbb, &DestroyPatternArgs { pattern }).as_union_value(),
            ),
            Spec::SetClips(clips) => {
                let clips: Vec<_> = clips
                    .iter()
                    .map(|&(tick, length, period, offset, pattern)| {
                        schema::Clip::new(tick, length, period, offset, pattern)
                    })
                    .collect();
                let clips = Some(fbb.create_vector(&clips));
                let set = SetClips::create(fbb, &SetClipsArgs { clips });
                (DeviceEdit::SetClips, set.as_union_value())
            }
            Spec::CreateInsert(node, strip) => {
                let strip = Some(param_values(fbb, strip));
                let create = CreateInsert::create(
                    fbb,
                    &CreateInsertArgs {
                        node,
                        strip,
                        metered: false,
                    },
                );
                (DeviceEdit::CreateInsert, create.as_union_value())
            }
            Spec::MeteredInsert(node, strip) => {
                let strip = Some(param_values(fbb, strip));
                let create = CreateInsert::create(
                    fbb,
                    &CreateInsertArgs {
                        node,
                        strip,
                        metered: true,
                    },
                );
                (DeviceEdit::CreateInsert, create.as_union_value())
            }
            Spec::Disconnect { from, to } => (
                DeviceEdit::Disconnect,
                Disconnect::create(fbb, &DisconnectArgs { from, to }).as_union_value(),
            ),
            Spec::PanicBuild(code) => (
                DeviceEdit::PanicBuild,
                PanicBuild::create(fbb, &PanicBuildArgs { code }).as_union_value(),
            ),
            Spec::HangBuild(code) => (
                DeviceEdit::HangBuild,
                HangBuild::create(fbb, &HangBuildArgs { code }).as_union_value(),
            ),
            Spec::LetGoOfNotes(node) => (
                DeviceEdit::LetGoOfNotes,
                LetGoOfNotes::create(fbb, &LetGoOfNotesArgs { node }).as_union_value(),
            ),
            Spec::Bare(kind) => {
                let start = fbb.start_table();
                (kind, fbb.end_table(start).as_union_value())
            }
            Spec::Missing => unreachable!("no table"),
        }
    }

    /// What a parcel brings, without the nodes themselves; cells and exits by their places in their tables.
    #[derive(Debug, PartialEq)]
    enum Brought {
        Reset(u32),
        Grow(Table, usize),
        CreateNode(usize),
        Remove {
            cell: usize,
            exit: usize,
        },
        /// Each step's node with what it hears, then what the output hears.
        Order(Vec<(Seat, Vec<Seat>)>, Vec<Seat>),
        GrowPatterns(usize),
        /// The cell, and the handle and notes of the pattern made in it.
        Pattern(usize, Option<(u32, Vec<Played>)>),
        /// Each clip's tick, last tick, period, offset and pattern.
        Arrangement(Vec<(u32, u32, u32, u32, u32)>),
        LetGo(Vec<u32>),
        Refused(Rejection),
    }

    fn brought_edit(edit: &Edit) -> Brought {
        match edit {
            Edit::Reset(epoch) => Brought::Reset(*epoch),
            Edit::Grow { table, nodes } => Brought::Grow(*table, nodes.len()),
            Edit::CreateNode { cell, .. } => Brought::CreateNode(cell.index()),
            Edit::Remove { cell, exit, .. } => Brought::Remove {
                cell: cell.index(),
                exit: exit.index(),
            },
            Edit::Order(order) => brought(order),
            Edit::GrowPatterns(patterns) => Brought::GrowPatterns(patterns.len()),
            Edit::Pattern { cell, pattern } => Brought::Pattern(
                cell.index(),
                pattern.as_ref().map(|(handle, pattern)| {
                    let notes = pattern.notes().iter().map(|note| {
                        (
                            note.tick,
                            note.node.raw(),
                            note.key,
                            note.velocity,
                            note.length,
                        )
                    });
                    (handle.raw(), notes.collect())
                }),
            ),
            Edit::Arrangement(arrangement) => Brought::Arrangement(
                arrangement
                    .clips()
                    .iter()
                    .map(|clip| {
                        (
                            clip.tick,
                            clip.last,
                            clip.period,
                            clip.offset,
                            clip.pattern.raw(),
                        )
                    })
                    .collect(),
            ),
            Edit::LetGo(nodes) => Brought::LetGo(nodes.iter().map(|node| node.raw()).collect()),
            Edit::Refused(reason) => Brought::Refused(*reason),
        }
    }

    /// Nodes in cells that hear nothing, and the output's.
    fn order(cells: &[u32], output: &[u32]) -> Brought {
        let steps: Vec<_> = cells.iter().map(|&cell| (cell, &[][..])).collect();
        wired(&steps, output)
    }

    fn wired(steps: &[(u32, &[u32])], output: &[u32]) -> Brought {
        let seats = |handles: &[u32]| {
            handles
                .iter()
                .map(|&handle| Seat::Cell(cell(handle)))
                .collect()
        };
        Brought::Order(
            steps
                .iter()
                .map(|&(handle, inputs)| (Seat::Cell(cell(handle)), seats(inputs)))
                .collect(),
            seats(output),
        )
    }

    fn brought(order: &Order) -> Brought {
        let sources = |range: std::ops::Range<usize>| {
            order.connections[range]
                .iter()
                .map(|connection| connection.source)
                .collect()
        };
        Brought::Order(
            order
                .steps
                .iter()
                .map(|step| (step.node, sources(step.inputs.clone())))
                .collect(),
            sources(order.output..order.connections.len()),
        )
    }

    fn builder() -> (Builder, AudioEnd) {
        let (build, audio) = handoff::channel();
        (Builder::new(SAMPLE_RATE, build), audio)
    }

    #[expect(
        clippy::unnecessary_box_returns,
        reason = "the parcel goes back to the audio end in its box"
    )]
    fn parcel(
        builder: &mut Builder,
        audio: &mut AudioEnd,
        batch: u32,
        bytes: &[u8],
    ) -> Box<Parcel> {
        builder.build(batch, bytes);
        let Arrival::Here(parcel) = audio.take(Batch::new(batch)) else {
            panic!("no parcel for batch {batch}");
        };
        parcel
    }

    fn built(
        builder: &mut Builder,
        audio: &mut AudioEnd,
        batch: u32,
        bytes: &[u8],
    ) -> Vec<Brought> {
        let parcel = parcel(builder, audio, batch, bytes);
        let brought = parcel.edits.iter().map(brought_edit).collect();
        audio.give_back(parcel);
        brought
    }

    #[test]
    fn every_edit_of_the_schema_is_known() {
        let (mut builder, mut audio) = builder();
        // A panic and a hang have tests of their own.
        let own = [
            DeviceEdit::NONE,
            DeviceEdit::PanicBuild,
            DeviceEdit::HangBuild,
        ];
        // Batches go in order, with no gaps.
        for (&kind, batch_number) in DeviceEdit::ENUM_VALUES
            .iter()
            .filter(|kind| !own.contains(kind))
            .zip(1..)
        {
            let brought = built(
                &mut builder,
                &mut audio,
                batch_number,
                &batch(&[Spec::Bare(kind)]),
            );
            let unknown = Brought::Refused(Rejection::UnknownCommand);
            assert!(!brought.contains(&unknown), "{kind:?}");
        }
    }

    #[test]
    #[should_panic(expected = "PanicBuild 7")]
    fn panic_build_panics_with_its_code() {
        let (mut builder, mut audio) = builder();
        built(&mut builder, &mut audio, 1, &batch(&[Spec::PanicBuild(7)]));
    }

    #[test]
    #[should_panic(expected = "hangs")]
    fn hang_build_hangs() {
        let (mut builder, mut audio) = builder();
        built(&mut builder, &mut audio, 1, &batch(&[Spec::HangBuild(7)]));
    }

    #[test]
    fn edits_the_engine_cannot_make_are_refused_one_by_one() {
        let (mut builder, mut audio) = builder();
        let unknown_version = Spec::CreateNode {
            node: 4,
            plugin: tone::DESCRIPTION.id,
            version: tone::DESCRIPTION.version + 1,
            params: &[],
            samples: &[],
            strip: &[],
        };
        let unknown_plugin = Spec::CreateNode {
            node: 4,
            plugin: 0,
            version: 1,
            params: &[],
            samples: &[],
            strip: &[],
        };
        let edits = [
            tone_node(1, &[]),
            tone_node(1, &[]),
            tone_node(handle(1, 1), &[]),
            tone_node(0, &[]),
            tone_node(handle(1, 0), &[]),
            unknown_version,
            unknown_plugin,
            Spec::SetOutput(0),
            Spec::SetOutput(2),
            Spec::SetOutput(handle(1, 1)),
            Spec::DestroyNode(0),
            Spec::DestroyNode(handle(1, 1)),
            Spec::Missing,
            Spec::Bare(DeviceEdit(DeviceEdit::ENUM_MAX + 1)),
            Spec::SetOutput(1),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::Refused(Rejection::CellTaken),
                Brought::Refused(Rejection::CellTaken),
                Brought::Refused(Rejection::InvalidHandle),
                Brought::Refused(Rejection::InvalidHandle),
                Brought::Refused(Rejection::UnknownPlugin),
                Brought::Refused(Rejection::UnknownPlugin),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::Malformed),
                Brought::Refused(Rejection::UnknownCommand),
                order(&[1], &[1]),
            ]
        );
    }

    #[test]
    fn bytes_that_are_not_a_batch_still_make_a_parcel() {
        let (mut builder, mut audio) = builder();
        let refused = [Brought::Refused(Rejection::Malformed)];
        assert_eq!(built(&mut builder, &mut audio, 1, &[]), refused);
        assert_eq!(built(&mut builder, &mut audio, 2, &[0xff; 9]), refused);
        assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
        // A table without a kind doesn't pass the check.
        let inconsistent = batch(&[tone_node(1, &[]), Spec::Bare(DeviceEdit::NONE)]);
        assert_eq!(built(&mut builder, &mut audio, 4, &inconsistent), refused);
    }

    #[test]
    fn a_value_the_node_refuses_leaves_its_parameter_at_the_default_and_the_node_is_made() {
        let (mut builder, mut audio) = builder();
        let volume = tone::VOLUME.get();
        let values = [(volume, f32::NAN), (volume + 1, 0.5), (volume, 0.25)];
        let edits = [tone_node(1, &values)];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::Refused(Rejection::InvalidValue),
                Brought::Refused(Rejection::UnknownTarget),
                order(&[1], &[]),
            ]
        );
    }

    #[test]
    fn a_strip_value_is_refused_on_its_own_and_the_node_is_made() {
        let (mut builder, mut audio) = builder();
        let values = [
            (VOLUME_NUMBER.get(), f32::NAN),
            (PAN_NUMBER.get() + 1, 0.5),
            (0, 0.5),
            (PAN_NUMBER.get(), 0.5),
        ];
        let edits = [
            Spec::CreateNode {
                node: 1,
                plugin: tone::DESCRIPTION.id,
                version: tone::DESCRIPTION.version,
                params: &[],
                samples: &[],
                strip: &values,
            },
            Spec::CreateInsert(2, &values),
        ];
        let refusals = || {
            [
                Rejection::InvalidValue,
                Rejection::UnknownTarget,
                Rejection::UnknownTarget,
            ]
            .map(Brought::Refused)
        };
        let mut expected = vec![Brought::CreateNode(1)];
        expected.extend(refusals());
        expected.push(Brought::CreateNode(2));
        expected.extend(refusals());
        expected.push(order(&[1, 2], &[]));
        assert_eq!(built(&mut builder, &mut audio, 1, &batch(&edits)), expected);
    }

    #[test]
    fn each_table_grows_once_per_parcel_before_anything_goes_in() {
        let (mut builder, mut audio) = builder();
        let edits = [tone_node(16, &[]), tone_node(handle(7, 32), &[])];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::Grow(Table::Cells, 64),
                Brought::CreateNode(16),
                Brought::CreateNode(32),
                order(&[16, 32], &[]),
            ]
        );
        let edits = [tone_node(63, &[]), tone_node(u32::from(u16::MAX), &[])];
        assert_eq!(
            built(&mut builder, &mut audio, 2, &batch(&edits)),
            [
                Brought::Grow(Table::Cells, usize::from(u16::MAX) + 1),
                Brought::CreateNode(63),
                Brought::CreateNode(usize::from(u16::MAX)),
                order(&[16, 32, 63, u32::from(u16::MAX)], &[]),
            ]
        );
        // A reset of more nodes than there are exits for removed ones.
        let many: Vec<_> = (1..=20).map(|cell| tone_node(cell, &[])).collect();
        built(&mut builder, &mut audio, 3, &batch(&many));
        let reset = built(&mut builder, &mut audio, 4, &batch(&[Spec::Reset(1)]));
        let grows: Vec<_> = reset
            .iter()
            .filter(|edit| matches!(edit, Brought::Grow(..)))
            .collect();
        assert_eq!(grows, [&Brought::Grow(Table::Exits, 32)]);
        assert_eq!(reset[0], Brought::Grow(Table::Exits, 32));
    }

    #[test]
    fn a_removed_node_frees_its_cell_at_once_and_plays_out_until_its_parcel_comes_back() {
        let (mut builder, mut audio) = builder();
        let edits = [tone_node(1, &[]), Spec::SetOutput(1)];
        built(&mut builder, &mut audio, 1, &batch(&edits));
        let again = [
            Spec::DestroyNode(1),
            tone_node(handle(1, 1), &[]),
            Spec::SetOutput(handle(1, 1)),
        ];
        let removal = parcel(&mut builder, &mut audio, 2, &batch(&again));
        assert!(removal.holds);
        let edits: Vec<_> = removal.edits.iter().map(brought_edit).collect();
        let playing_out = Seat::Exit(Exit::new(0));
        assert_eq!(
            edits,
            [
                Brought::Remove { cell: 1, exit: 0 },
                Brought::CreateNode(1),
                Brought::Order(
                    vec![(playing_out, vec![]), (Seat::Cell(cell(1)), vec![])],
                    vec![playing_out, Seat::Cell(cell(1))]
                ),
            ]
        );
        // Until the parcel is back, its exit stays taken.
        built(&mut builder, &mut audio, 3, &batch(&[]));
        audio.give_back(removal);
        assert_eq!(builder.collect(), 0);
        assert_eq!(
            built(&mut builder, &mut audio, 4, &batch(&[])),
            [order(&[1], &[1])]
        );
    }

    #[test]
    fn a_reset_removes_every_node_and_starts_a_session() {
        let (mut builder, mut audio) = builder();
        let edits = [tone_node(20, &[]), tone_node(2, &[]), connect(2, 20)];
        built(&mut builder, &mut audio, 1, &batch(&edits));
        let reset = [Spec::Reset(3), Spec::SetOutput(20), tone_node(20, &[])];
        let parcel = parcel(&mut builder, &mut audio, 2, &batch(&reset));
        assert!(parcel.holds);
        let edits: Vec<_> = parcel.edits.iter().map(brought_edit).collect();
        let [two, twenty] = [Seat::Exit(Exit::new(0)), Seat::Exit(Exit::new(1))];
        assert_eq!(
            edits,
            [
                Brought::Reset(3),
                Brought::Remove { cell: 2, exit: 0 },
                Brought::Remove { cell: 20, exit: 1 },
                Brought::Refused(Rejection::UnknownTarget),
                Brought::CreateNode(20),
                Brought::Order(
                    vec![
                        (two, vec![]),
                        (twenty, vec![two]),
                        (Seat::Cell(cell(20)), vec![])
                    ],
                    vec![]
                ),
            ]
        );
    }

    #[test]
    fn the_order_comes_only_with_batches_that_change_the_graph() {
        let (mut builder, mut audio) = builder();
        let added = batch(&[tone_node(2, &[]), tone_node(1, &[])]);
        assert_eq!(
            built(&mut builder, &mut audio, 1, &added),
            [
                Brought::CreateNode(2),
                Brought::CreateNode(1),
                order(&[2, 1], &[]),
            ]
        );
        let output = batch(&[Spec::SetOutput(1), tone_node(1, &[])]);
        assert_eq!(
            built(&mut builder, &mut audio, 2, &output),
            [Brought::Refused(Rejection::CellTaken), order(&[2, 1], &[1]),]
        );
        let same = batch(&[Spec::SetOutput(1)]);
        assert_eq!(built(&mut builder, &mut audio, 3, &same), []);
        // A connection alone changes what a node hears; a refused one changes nothing.
        assert_eq!(
            built(&mut builder, &mut audio, 4, &batch(&[connect(1, 2)])),
            [wired(&[(1, &[]), (2, &[1])], &[1])]
        );
        assert_eq!(
            built(&mut builder, &mut audio, 5, &batch(&[connect(2, 1)])),
            [Brought::Refused(Rejection::Loop)]
        );
    }

    #[test]
    fn a_node_goes_after_the_nodes_it_hears_whenever_it_was_made() {
        let (mut builder, mut audio) = builder();
        let edits = [
            tone_node(1, &[]),
            tone_node(2, &[]),
            tone_node(3, &[]),
            connect(3, 2),
            connect(2, 1),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::CreateNode(2),
                Brought::CreateNode(3),
                wired(&[(3, &[]), (2, &[3]), (1, &[2])], &[]),
            ]
        );
        // One node can feed several, and a node hears all of its inputs.
        let edits = [tone_node(4, &[]), connect(4, 1), connect(3, 1)];
        assert_eq!(
            built(&mut builder, &mut audio, 2, &batch(&edits)),
            [
                Brought::CreateNode(4),
                wired(&[(3, &[]), (2, &[3]), (4, &[]), (1, &[2, 4, 3])], &[]),
            ]
        );
    }

    #[test]
    fn connections_the_engine_cannot_make_are_refused_one_by_one() {
        let (mut builder, mut audio) = builder();
        let edits = [
            tone_node(1, &[]),
            tone_node(2, &[]),
            tone_node(3, &[]),
            connect(1, 2),
            connect(2, 3),
            connect(3, 1),
            connect(2, 2),
            connect(1, 2),
            connect(1, 9),
            connect(9, 1),
            connect(0, 1),
            connect(1, 0),
            connect(handle(1, 1), 3),
            connect(1, 3),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::CreateNode(2),
                Brought::CreateNode(3),
                Brought::Refused(Rejection::Loop),
                Brought::Refused(Rejection::Loop),
                Brought::Refused(Rejection::AlreadyConnected),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                wired(&[(1, &[]), (2, &[1]), (3, &[2, 1])], &[]),
            ]
        );
    }

    #[test]
    fn an_insert_takes_a_handle_as_a_node_does() {
        let (mut builder, mut audio) = builder();
        let edits = [
            Spec::CreateInsert(1, &[]),
            Spec::CreateInsert(0, &[]),
            Spec::CreateInsert(handle(1, 1), &[]),
            tone_node(2, &[]),
            connect(2, 1),
            Spec::SetOutput(1),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::Refused(Rejection::InvalidHandle),
                Brought::Refused(Rejection::CellTaken),
                Brought::CreateNode(2),
                wired(&[(2, &[]), (1, &[2])], &[1]),
            ]
        );
    }

    #[test]
    fn only_a_connection_between_live_nodes_that_is_kept_can_be_disconnected() {
        let (mut builder, mut audio) = builder();
        let edits = [
            tone_node(1, &[]),
            tone_node(2, &[]),
            connect(1, 2),
            disconnect(2, 1),
            disconnect(1, 9),
            disconnect(0, 2),
            disconnect(handle(1, 1), 2),
            disconnect(1, 2),
            disconnect(1, 2),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::CreateNode(2),
                Brought::Refused(Rejection::NotConnected),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::NotConnected),
                wired(&[(1, &[]), (2, &[1])], &[]),
            ]
        );
    }

    #[test]
    fn a_removed_node_takes_its_connections_along_once_its_parcel_is_back() {
        let (mut builder, mut audio) = builder();
        let edits = [
            tone_node(1, &[]),
            tone_node(2, &[]),
            tone_node(3, &[]),
            connect(1, 2),
            connect(2, 3),
            Spec::SetOutput(3),
        ];
        built(&mut builder, &mut audio, 1, &batch(&edits));
        let removal = parcel(&mut builder, &mut audio, 2, &batch(&[Spec::DestroyNode(2)]));
        audio.give_back(removal);
        builder.collect();
        assert_eq!(
            built(&mut builder, &mut audio, 3, &batch(&[])),
            [wired(&[(1, &[]), (3, &[])], &[3])]
        );
    }

    #[test]
    fn a_pattern_comes_sorted_by_tick_with_the_notes_no_note_can_have_dropped_under_one_refusal() {
        let (mut builder, mut audio) = builder();
        let notes = [
            (480, 1, 60, 1.0, 240),
            (0, 1, 62, 2.0, 240),
            (240, 1, 128, 1.0, 240),
            (240, 1, 61, f32::NAN, 240),
            (0, 1, 64, -1.0, 240),
            (240, 1, 66, 1.0, 0),
            (240, 1, 65, 0.5, 240),
        ];
        let edits = [tone_node(1, &[]), Spec::SetPattern(1, &notes)];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::Pattern(
                    1,
                    Some((
                        1,
                        vec![
                            (0, 1, 62, 1.0, 240),
                            (0, 1, 64, 0.0, 240),
                            (240, 1, 65, 0.5, 240),
                            (480, 1, 60, 1.0, 240),
                        ]
                    ))
                ),
                Brought::Refused(Rejection::InvalidValue),
                order(&[1], &[]),
            ]
        );
        // A pattern without notes is silence; one without a handle, none.
        let (empty, bare) = (Spec::SetPattern(2, &[]), Spec::Bare(DeviceEdit::SetPattern));
        assert_eq!(
            built(&mut builder, &mut audio, 2, &batch(&[empty, bare])),
            [
                Brought::Pattern(2, Some((2, vec![]))),
                Brought::Refused(Rejection::InvalidHandle)
            ]
        );
    }

    #[test]
    fn a_pattern_is_made_in_a_free_cell_and_replaced_under_its_handle_and_its_cell_is_free_once_it_goes()
     {
        let (mut builder, mut audio) = builder();
        let one = [(0, 1, 60, 1.0, 240)];
        let edits = [
            tone_node(1, &[]),
            Spec::SetPattern(1, &[]),
            Spec::SetPattern(1, &one),
            Spec::SetPattern(handle(1, 1), &[]),
            Spec::DestroyPattern(handle(1, 1)),
            Spec::DestroyPattern(2),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::Pattern(1, Some((1, vec![]))),
                Brought::Pattern(1, Some((1, vec![(0, 1, 60, 1.0, 240)]))),
                Brought::Refused(Rejection::CellTaken),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Refused(Rejection::UnknownTarget),
                order(&[1], &[]),
            ]
        );
        let edits = [
            Spec::DestroyPattern(1),
            Spec::SetPattern(handle(1, 1), &one),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 2, &batch(&edits)),
            [
                Brought::Pattern(1, None),
                Brought::Pattern(1, Some((handle(1, 1), vec![(0, 1, 60, 1.0, 240)]))),
            ]
        );
    }

    #[test]
    fn the_pattern_table_grows_before_the_parcel_puts_a_pattern_past_it() {
        let (mut builder, mut audio) = builder();
        let past = FIRST_PATTERN_CELLS;
        let handle = |cell: usize| u32::try_from(cell).unwrap();
        let edits = [
            Spec::SetPattern(handle(past + 1), &[]),
            Spec::SetPattern(handle(past), &[]),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::GrowPatterns(2 * FIRST_PATTERN_CELLS),
                Brought::Pattern(past + 1, Some((handle(past + 1), vec![]))),
                Brought::Pattern(past, Some((handle(past), vec![]))),
            ]
        );
        let last = usize::from(u16::MAX);
        let edits = [Spec::SetPattern(handle(last), &[])];
        assert_eq!(
            built(&mut builder, &mut audio, 2, &batch(&edits)),
            [
                Brought::GrowPatterns(last + 1),
                Brought::Pattern(last, Some((handle(last), vec![]))),
            ]
        );
    }

    #[test]
    fn clips_come_sorted_by_tick_to_their_last_ticks_with_those_of_no_length_or_period_dropped_under_one_refusal()
     {
        let (mut builder, mut audio) = builder();
        // An offset past the period is taken round it.
        let clips = [
            (960, 480, 960, 1000, 1),
            (0, 960, 960, 0, 2),
            (0, 0, 960, 0, 1),
            (u32::MAX - 1, 10, 3, 2, 1),
            (0, 960, 0, 0, 1),
        ];
        let edits = [
            Spec::SetPattern(1, &[]),
            Spec::SetPattern(2, &[]),
            Spec::SetClips(&clips),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits))[2..],
            [
                Brought::Arrangement(vec![
                    (0, 959, 960, 0, 2),
                    (960, 1439, 960, 40, 1),
                    (u32::MAX - 1, u32::MAX, 3, 2, 1)
                ]),
                Brought::Refused(Rejection::InvalidValue),
            ]
        );
    }

    #[test]
    fn after_every_batch_the_clips_name_only_live_patterns_or_the_batch_gets_one_refusal() {
        let (mut builder, mut audio) = builder();
        // The patterns may come after the clips in their batch.
        let edits = [
            Spec::SetClips(&[(0, 960, 960, 0, 1), (960, 960, 960, 0, 2)]),
            Spec::SetPattern(1, &[]),
            Spec::SetPattern(2, &[]),
        ];
        let made = built(&mut builder, &mut audio, 1, &batch(&edits));
        assert!(!made.contains(&Brought::Refused(Rejection::UnknownTarget)));
        // A pattern removed without clips that leave it out.
        assert_eq!(
            built(
                &mut builder,
                &mut audio,
                2,
                &batch(&[Spec::DestroyPattern(2)])
            ),
            [
                Brought::Pattern(2, None),
                Brought::Refused(Rejection::UnknownTarget),
            ]
        );
        // Told once, by the batch that broke the rule.
        assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
        let edits = [Spec::SetClips(&[(0, 960, 960, 0, handle(1, 1))])];
        assert_eq!(
            built(&mut builder, &mut audio, 4, &batch(&edits)),
            [
                Brought::Arrangement(vec![(0, 959, 960, 0, handle(1, 1))]),
                Brought::Refused(Rejection::UnknownTarget),
            ]
        );
        // A pattern the clips don't name goes without a word.
        let edits = [
            Spec::SetClips(&[(0, 960, 960, 0, 1)]),
            Spec::SetPattern(3, &[]),
            Spec::DestroyPattern(3),
        ];
        let refusals = built(&mut builder, &mut audio, 5, &batch(&edits))
            .into_iter()
            .filter(|edit| matches!(edit, Brought::Refused(_)))
            .count();
        assert_eq!(refusals, 0);
    }

    #[test]
    fn notes_are_let_go_of_only_for_live_nodes_in_one_edit_each_node_once() {
        let (mut builder, mut audio) = builder();
        let edits = [
            tone_node(1, &[]),
            tone_node(2, &[]),
            Spec::LetGoOfNotes(2),
            Spec::LetGoOfNotes(3),
            Spec::LetGoOfNotes(1),
            Spec::LetGoOfNotes(2),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 1, &batch(&edits)),
            [
                Brought::CreateNode(1),
                Brought::CreateNode(2),
                Brought::Refused(Rejection::UnknownTarget),
                Brought::LetGo(vec![1, 2]),
                order(&[1, 2], &[]),
            ]
        );
    }

    #[test]
    fn after_every_batch_the_pattern_names_only_live_nodes_or_the_batch_gets_one_refusal() {
        let (mut builder, mut audio) = builder();
        let notes = [
            (0, 1, 60, 1.0, 240),
            (240, 2, 60, 1.0, 240),
            (480, 1, 60, 1.0, 240),
        ];
        // The nodes may come after the pattern in its batch.
        let edits = [
            Spec::SetPattern(1, &notes),
            tone_node(1, &[]),
            tone_node(2, &[]),
        ];
        let made = built(&mut builder, &mut audio, 1, &batch(&edits));
        assert!(!made.contains(&Brought::Refused(Rejection::UnknownTarget)));
        // A node removed without a pattern that leaves it out.
        let removed = built(&mut builder, &mut audio, 2, &batch(&[Spec::DestroyNode(2)]));
        assert_eq!(
            removed,
            [
                Brought::Remove { cell: 2, exit: 0 },
                Brought::Refused(Rejection::UnknownTarget),
                Brought::Order(
                    vec![
                        (Seat::Cell(cell(1)), vec![]),
                        (Seat::Exit(Exit::new(0)), vec![])
                    ],
                    vec![]
                ),
            ]
        );
        // Told once, by the batch that broke the rule.
        assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
        let other_generation = [(0, handle(1, 1), 60, 1.0, 240), (0, 0, 60, 1.0, 240)];
        assert_eq!(
            built(
                &mut builder,
                &mut audio,
                4,
                &batch(&[Spec::SetPattern(1, &other_generation)])
            ),
            [
                Brought::Pattern(
                    1,
                    Some((
                        1,
                        vec![(0, handle(1, 1), 60, 1.0, 240), (0, 0, 60, 1.0, 240)]
                    ))
                ),
                Brought::Refused(Rejection::UnknownTarget),
            ]
        );
        // A node no pattern names goes without a word.
        let first = [(0, 1, 60, 1.0, 240)];
        built(
            &mut builder,
            &mut audio,
            5,
            &batch(&[Spec::SetPattern(1, &first)]),
        );
        let edits = [tone_node(3, &[]), Spec::DestroyNode(3)];
        let refusals = built(&mut builder, &mut audio, 6, &batch(&edits))
            .into_iter()
            .filter(|edit| matches!(edit, Brought::Refused(_)))
            .count();
        assert_eq!(refusals, 0);
    }

    #[test]
    fn a_reset_takes_the_patterns_and_clips_away_and_a_rebuild_in_its_batch_brings_them_back() {
        let (mut builder, mut audio) = builder();
        let notes = [(0, 1, 60, 1.0, 240)];
        built(&mut builder, &mut audio, 1, &batch(&[Spec::Reset(1)]));
        let edits = [
            tone_node(1, &[]),
            Spec::SetPattern(2, &notes),
            Spec::SetPattern(1, &[]),
            Spec::SetClips(&[(0, 960, 960, 0, 2)]),
        ];
        built(&mut builder, &mut audio, 2, &batch(&edits));
        let rebuild = [
            Spec::Reset(2),
            tone_node(handle(1, 1), &[]),
            Spec::SetPattern(handle(1, 1), &[(0, handle(1, 1), 60, 1.0, 240)]),
            Spec::SetClips(&[(0, 960, 960, 0, handle(1, 1))]),
        ];
        assert_eq!(
            built(&mut builder, &mut audio, 3, &batch(&rebuild)),
            [
                Brought::Reset(2),
                Brought::Remove { cell: 1, exit: 0 },
                Brought::Pattern(1, None),
                Brought::Pattern(2, None),
                Brought::Arrangement(vec![]),
                Brought::CreateNode(1),
                Brought::Pattern(
                    1,
                    Some((handle(1, 1), vec![(0, handle(1, 1), 60, 1.0, 240)]))
                ),
                Brought::Arrangement(vec![(0, 959, 960, 0, handle(1, 1))]),
                Brought::Order(
                    vec![
                        (Seat::Exit(Exit::new(0)), vec![]),
                        (Seat::Cell(cell(1)), vec![])
                    ],
                    vec![]
                ),
            ]
        );
        // Without patterns or clips to take away, a reset brings none.
        let edits = [Spec::SetClips(&[]), Spec::DestroyPattern(handle(1, 1))];
        built(&mut builder, &mut audio, 4, &batch(&edits));
        let reset = built(&mut builder, &mut audio, 5, &batch(&[Spec::Reset(3)]));
        assert!(
            !reset
                .iter()
                .any(|edit| matches!(edit, Brought::Pattern(..) | Brought::Arrangement(_)))
        );
    }
}
