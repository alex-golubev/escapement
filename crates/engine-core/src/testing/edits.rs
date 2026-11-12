//! Batches of edits as the page writes them.

use engine_plugins::PluginDescription;
use flatbuffers::{FlatBufferBuilder, UnionWIPOffset, Vector, WIPOffset};

use crate::pool::Hash;
use crate::schema::{
    self, Connect, ConnectArgs, CreateInsert, CreateInsertArgs, CreateNodeArgs, DestroyNode,
    DestroyNodeArgs, DestroyPattern, DestroyPatternArgs, DeviceBatch, DeviceBatchArgs, DeviceEdit,
    Disconnect, DisconnectArgs, EditArgs, HangBuild, HangBuildArgs, LetGoOfNotes, LetGoOfNotesArgs,
    PanicBuild, PanicBuildArgs, ParamValue, PatternNote, Reset, ResetArgs, SampleSound, SetClips,
    SetClipsArgs, SetOutput, SetOutputArgs, SetPatternArgs,
};

/// An edit as the page writes it.
#[derive(Clone, Copy)]
pub(crate) enum Spec<'a> {
    Reset(u32),
    CreateNode(NewNode<'a>),
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
    CreateInsert {
        node: u32,
        strip: &'a [(u32, f32)],
        metered: bool,
    },
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
pub(crate) type Played = (u32, u32, u8, f32, u32);

/// A clip: tick, length, period, offset and pattern.
pub(crate) type Placed = (u32, u32, u32, u32, u32);

/// A node to create, with its initial values.
#[derive(Clone, Copy)]
pub(crate) struct NewNode<'a> {
    node: u32,
    plugin: u32,
    version: u32,
    params: &'a [(u32, f32)],
    samples: &'a [(u32, Hash)],
    strip: &'a [(u32, f32)],
}

impl<'a> NewNode<'a> {
    /// Of the plugin `description` describes, with no initial values.
    pub(crate) fn of(node: u32, description: &PluginDescription) -> Self {
        Self {
            node,
            plugin: description.id,
            version: description.version,
            params: &[],
            samples: &[],
            strip: &[],
        }
    }

    pub(crate) fn plugin(self, plugin: u32) -> Self {
        Self { plugin, ..self }
    }

    pub(crate) fn version(self, version: u32) -> Self {
        Self { version, ..self }
    }

    pub(crate) fn params(self, params: &'a [(u32, f32)]) -> Self {
        Self { params, ..self }
    }

    pub(crate) fn samples(self, samples: &'a [(u32, Hash)]) -> Self {
        Self { samples, ..self }
    }

    pub(crate) fn strip(self, strip: &'a [(u32, f32)]) -> Self {
        Self { strip, ..self }
    }
}

impl<'a> From<NewNode<'a>> for Spec<'a> {
    fn from(node: NewNode<'a>) -> Self {
        Self::CreateNode(node)
    }
}

/// [`NewNode::of`], as an edit.
pub(crate) fn create_node(node: u32, description: &PluginDescription) -> Spec<'static> {
    Spec::CreateNode(NewNode::of(node, description))
}

/// An insert without a meter.
pub(crate) fn create_insert(node: u32, strip: &[(u32, f32)]) -> Spec<'_> {
    Spec::CreateInsert {
        node,
        strip,
        metered: false,
    }
}

pub(crate) fn connect(from: u32, to: u32) -> Spec<'static> {
    Spec::Connect { from, to }
}

pub(crate) fn disconnect(from: u32, to: u32) -> Spec<'static> {
    Spec::Disconnect { from, to }
}

/// The handle of a cell in its `generation`.
pub(crate) const fn handle(generation: u32, cell: u32) -> u32 {
    generation << 16 | cell
}

pub(crate) fn batch(specs: &[Spec<'_>]) -> Vec<u8> {
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
        Spec::CreateNode(NewNode {
            node,
            plugin,
            version,
            params,
            samples,
            strip,
        }) => {
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
        Spec::CreateInsert {
            node,
            strip,
            metered,
        } => {
            let strip = Some(param_values(fbb, strip));
            let create = CreateInsert::create(
                fbb,
                &CreateInsertArgs {
                    node,
                    strip,
                    metered,
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
