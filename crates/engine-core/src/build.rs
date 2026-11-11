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
mod tests;
