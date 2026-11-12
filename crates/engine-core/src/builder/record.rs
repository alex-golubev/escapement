//! The build thread's record of the graph the audio thread will have once every parcel sent is applied: live nodes
//! by cell, removed ones still playing out, what each hears and what the output hears. It changes only through these
//! methods, and each notes the change, so a batch sends the audio thread a new order exactly when it changed the
//! graph.

use std::collections::{HashMap, HashSet};
use std::mem;

use crate::graph::{Connection, Exit, Order, Seat, Start, Turn};
use crate::handle::{NodeCell, NodeHandle};
use crate::handoff::Batch;
use crate::schema::Rejection;

/// Never reused, unlike cells and exits.
type Id = u64;

struct Entry {
    handle: NodeHandle,
    /// What it hears.
    inputs: Vec<Input>,
    state: State,
}

/// A connection a node, or the output, hears.
#[derive(Clone, Copy)]
struct Input {
    source: Id,
    /// The batch that started its fade, if it is fading out.
    fading_since: Option<Batch>,
}

impl Input {
    fn kept(source: Id) -> Self {
        Self {
            source,
            fading_since: None,
        }
    }

    /// As the page sees the graph: a fading connection is gone.
    fn is_kept(&self) -> bool {
        self.fading_since.is_none()
    }

    /// Whether the batch's parcel coming back takes it away.
    fn goes(&self, batch: Batch, gone: &HashSet<Id>) -> bool {
        self.fading_since == Some(batch) || gone.contains(&self.source)
    }
}

#[derive(Clone, Copy)]
enum State {
    Live {
        cell: NodeCell,
    },
    /// Removed; plays out at the exit until the parcel of the batch that removed it comes back.
    Leaving {
        exit: Exit,
    },
}

/// What the last order sent holds, for the next one to start from.
#[derive(Default)]
struct Sent {
    /// Each connection by listener (`None` for the output) and source, at its index in the order.
    connections: HashMap<(Option<Id>, Id), usize>,
    /// Every node the output heard through it, however far upstream.
    heard: HashSet<Id>,
}

/// A removed node's way out of its cell.
#[derive(Debug, PartialEq)]
pub(super) struct Removal {
    pub cell: NodeCell,
    pub exit: Exit,
}

pub(super) struct Record {
    /// Live nodes by cell.
    cells: Vec<Option<Id>>,
    free_exits: Vec<Exit>,
    exits: usize,
    entries: HashMap<Id, Entry>,
    /// Nodes playing out, by the batch that removed them.
    leaving: HashMap<Batch, Vec<Id>>,
    /// Every node; after the nodes it hears once sorted.
    order: Vec<Id>,
    /// What the output hears.
    output: Vec<Input>,
    sent: Sent,
    next_id: Id,
    changed: bool,
    /// Whether the batch started a fade.
    holds: bool,
}

impl Record {
    pub(super) fn new(cells: usize, exits: usize) -> Self {
        Self {
            cells: vec![None; cells],
            free_exits: (0..exits).rev().map(Exit::new).collect(),
            exits,
            entries: HashMap::new(),
            leaving: HashMap::new(),
            order: Vec::new(),
            output: Vec::new(),
            sent: Sent::default(),
            next_id: 0,
            changed: false,
            holds: false,
        }
    }

    /// The size of the audio thread's table of cells.
    pub(super) fn cells(&self) -> usize {
        self.cells.len()
    }

    /// The size of the audio thread's table of exits.
    pub(super) fn exits(&self) -> usize {
        self.exits
    }

    /// Under this very handle.
    pub(super) fn has_live(&self, handle: NodeHandle) -> bool {
        self.live(handle).is_some()
    }

    /// Whatever the generation.
    pub(super) fn is_taken(&self, cell: NodeCell) -> bool {
        self.cells.get(cell.index()).is_some_and(Option::is_some)
    }

    /// Room for `cell`, doubling; the audio thread's table grows in the same parcel.
    pub(super) fn make_room(&mut self, cell: NodeCell) {
        if cell.index() >= self.cells.len() {
            self.cells
                .resize((cell.index() + 1).next_power_of_two(), None);
        }
    }

    /// A node that hears nothing yet, in a free cell of the table.
    pub(super) fn add(&mut self, handle: NodeHandle) {
        debug_assert!(!self.is_taken(handle.cell()));
        let id = self.next_id;
        self.next_id += 1;
        let cell = handle.cell();
        self.cells[cell.index()] = Some(id);
        let entry = Entry {
            handle,
            inputs: Vec::new(),
            state: State::Live { cell },
        };
        self.entries.insert(id, entry);
        self.order.push(id);
        self.changed = true;
    }

    /// `to` hears `from`; a connection between them still fading out rises again from where it got to.
    pub(super) fn connect(&mut self, from: NodeHandle, to: NodeHandle) -> Result<(), Rejection> {
        let (Some(from), Some(to)) = (self.live(from), self.live(to)) else {
            return Err(Rejection::UnknownTarget);
        };
        let heard = self
            .inputs(to)
            .iter()
            .position(|input| input.source == from);
        // Heard twice, it would be twice as loud.
        if heard.is_some_and(|index| self.inputs(to)[index].is_kept()) {
            return Err(Rejection::AlreadyConnected);
        }
        // As the page sees it: nodes playing out and fading connections are gone.
        if self
            .upstream([from], |input| self.orders(input))
            .contains(&to)
        {
            return Err(Rejection::Loop);
        }
        if let Some(entry) = self.entries.get_mut(&to) {
            match heard {
                Some(index) => entry.inputs[index].fading_since = None,
                None => entry.inputs.push(Input::kept(from)),
            }
        }
        self.changed = true;
        Ok(())
    }

    /// `to` stops hearing `from`: the connection fades out until the batch's parcel comes back.
    pub(super) fn disconnect(
        &mut self,
        from: NodeHandle,
        to: NodeHandle,
        batch: Batch,
    ) -> Result<(), Rejection> {
        let (Some(from), Some(to)) = (self.live(from), self.live(to)) else {
            return Err(Rejection::UnknownTarget);
        };
        let input = self
            .entries
            .get_mut(&to)
            .and_then(|entry| {
                entry
                    .inputs
                    .iter_mut()
                    .find(|input| input.source == from && input.is_kept())
            })
            .ok_or(Rejection::NotConnected)?;
        input.fading_since = Some(batch);
        self.changed = true;
        self.holds = true;
        Ok(())
    }

    /// The output hears the node, and what it heard before fades out.
    pub(super) fn set_output(&mut self, handle: NodeHandle, batch: Batch) -> Result<(), Rejection> {
        let id = self.live(handle).ok_or(Rejection::UnknownTarget)?;
        let mut found = false;
        for heard in &mut self.output {
            if heard.source == id {
                found = true;
                self.changed |= heard.fading_since.take().is_some();
            } else if heard.is_kept() {
                heard.fading_since = Some(batch);
                self.changed = true;
                self.holds = true;
            }
        }
        if !found {
            self.output.push(Input::kept(id));
            self.changed = true;
        }
        Ok(())
    }

    /// Takes the node out of its cell to play out until the batch's parcel comes back; what hears it fades it out
    /// meanwhile.
    pub(super) fn remove(
        &mut self,
        handle: NodeHandle,
        batch: Batch,
    ) -> Result<Removal, Rejection> {
        let id = self.live(handle).ok_or(Rejection::UnknownTarget)?;
        let cell = handle.cell();
        if self.free_exits.is_empty() {
            self.grow_exits();
        }
        let Some(exit) = self.free_exits.pop() else {
            unreachable!("the exits just grew");
        };
        self.cells[cell.index()] = None;
        if let Some(entry) = self.entries.get_mut(&id) {
            entry.state = State::Leaving { exit };
        }
        self.leaving.entry(batch).or_default().push(id);
        for heard in &mut self.output {
            if heard.source == id && heard.is_kept() {
                heard.fading_since = Some(batch);
            }
        }
        self.changed = true;
        self.holds = true;
        Ok(Removal { cell, exit })
    }

    /// Every live node, as a reset removes them.
    pub(super) fn live_handles(&self) -> Vec<NodeHandle> {
        self.cells
            .iter()
            .flatten()
            .map(|id| self.entries[id].handle)
            .collect()
    }

    /// Forgets what the batch faded out: its parcel came back, so that is silent and back on this thread.
    pub(super) fn finish(&mut self, batch: Batch) {
        let gone: HashSet<Id> = self
            .leaving
            .remove(&batch)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for id in &gone {
            if let Some(Entry {
                state: State::Leaving { exit },
                ..
            }) = self.entries.remove(id)
            {
                self.free_exits.push(exit);
            }
        }
        let mut faded = false;
        for inputs in self
            .entries
            .values_mut()
            .map(|entry| &mut entry.inputs)
            .chain([&mut self.output])
        {
            let before = inputs.len();
            inputs.retain(|input| !input.goes(batch, &gone));
            faded |= inputs.len() != before;
        }
        if !gone.is_empty() {
            self.order.retain(|id| !gone.contains(id));
        }
        self.changed |= !gone.is_empty() || faded;
    }

    /// Whether the batch built since the last call started a fade.
    pub(super) fn take_holds(&mut self) -> bool {
        mem::take(&mut self.holds)
    }

    /// What the audio thread renders, in order, what each node hears and what the output hears, if the graph changed
    /// since the last call.
    pub(super) fn take_changes(&mut self) -> Option<Order> {
        if !mem::take(&mut self.changed) {
            return None;
        }
        self.order = sort(
            |id| self.inputs(id),
            |input| self.orders(input),
            &self.order,
        );
        let mut sent = Sent::default();
        let mut connections = Vec::new();
        let mut turns = Vec::with_capacity(self.order.len());
        for &id in &self.order {
            let first = connections.len();
            for input in self.inputs(id) {
                sent.connections
                    .insert((Some(id), input.source), connections.len());
                connections.push(self.connection(Some(id), input));
            }
            turns.push(Turn {
                node: self.seat(id),
                inputs: first..connections.len(),
            });
        }
        let output = connections.len();
        for heard in &self.output {
            sent.connections
                .insert((None, heard.source), connections.len());
            connections.push(self.connection(None, heard));
        }
        sent.heard = self.upstream(self.output.iter().map(|heard| heard.source), |_| true);
        self.sent = sent;
        Some(Order {
            turns: turns.into(),
            connections: connections.into(),
            output,
        })
    }

    /// Rises while it orders its listener, otherwise falls. Starts where the audio thread has it: as it got to if the
    /// last order had it, otherwise silent; where no one heard what it feeds, at once where it heads.
    fn connection(&self, listener: Option<Id>, input: &Input) -> Connection {
        let rising = self.orders(input);
        let unheard = listener.is_some_and(|id| !self.sent.heard.contains(&id));
        let start = match self.sent.connections.get(&(listener, input.source)) {
            _ if unheard && rising => Start::Full,
            Some(&index) if !unheard => Start::As(index),
            _ => Start::Silent,
        };
        Connection::new(self.seat(input.source), rising, start)
    }

    fn seat(&self, id: Id) -> Seat {
        match self.entries[&id].state {
            State::Live { cell } => Seat::Cell(cell),
            State::Leaving { exit } => Seat::Exit(exit),
        }
    }

    fn is_live(&self, id: Id) -> bool {
        matches!(self.entries[&id].state, State::Live { .. })
    }

    fn inputs(&self, id: Id) -> &[Input] {
        self.entries.get(&id).map_or(&[], |entry| &entry.inputs)
    }

    /// Whether its listener waits for its source: only a kept connection from a live node.
    fn orders(&self, input: &Input) -> bool {
        input.is_kept() && self.is_live(input.source)
    }

    /// The live node under this very handle.
    fn live(&self, handle: NodeHandle) -> Option<Id> {
        let id = (*self.cells.get(handle.cell().index())?)?;
        (self.entries[&id].handle == handle).then_some(id)
    }

    /// The nodes and every node they hear through connections that `follow`, however far upstream.
    fn upstream(
        &self,
        nodes: impl IntoIterator<Item = Id>,
        follow: impl Fn(&Input) -> bool,
    ) -> HashSet<Id> {
        let mut seen = HashSet::new();
        let mut waiting: Vec<Id> = nodes.into_iter().collect();
        while let Some(id) = waiting.pop() {
            if seen.insert(id) {
                waiting.extend(
                    self.inputs(id)
                        .iter()
                        .filter(|input| follow(input))
                        .map(|input| input.source),
                );
            }
        }
        seen
    }

    /// Doubles the table of exits; the audio thread's grows in the same parcel.
    fn grow_exits(&mut self) {
        let exits = (self.exits * 2).max(1);
        self.free_exits
            .extend((self.exits..exits).rev().map(Exit::new));
        self.exits = exits;
    }
}

/// Every node after the sources it hears through connections that `orders`, otherwise as in `order`. Without
/// recursion, so a long chain can't run out of stack. Those connections can't close a loop: only kept ones from live
/// nodes order their listeners, and `connect` refuses a loop among them; a listener may hear a removed node, or one
/// through a fading connection, a block late.
fn sort<'a>(
    heard_by: impl Fn(Id) -> &'a [Input],
    orders: impl Fn(&Input) -> bool,
    order: &[Id],
) -> Vec<Id> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        /// Waiting for its inputs to be placed.
        Open,
        Placed,
    }
    let mut marks = HashMap::with_capacity(order.len());
    let mut sorted = Vec::with_capacity(order.len());
    // Open nodes, each with the next of its inputs to look at.
    let mut open: Vec<(Id, usize)> = Vec::new();
    for &start in order {
        if marks.contains_key(&start) {
            continue;
        }
        marks.insert(start, Mark::Open);
        open.push((start, 0));
        while let Some((node, next)) = open.last_mut() {
            let node = *node;
            let Some(input) = heard_by(node).get(*next) else {
                open.pop();
                marks.insert(node, Mark::Placed);
                sorted.push(node);
                continue;
            };
            *next += 1;
            if !orders(input) {
                continue;
            }
            let source = input.source;
            match marks.get(&source) {
                Some(Mark::Placed) => {}
                Some(Mark::Open) => unreachable!("a loop got past `connect`"),
                None => {
                    marks.insert(source, Mark::Open);
                    open.push((source, 0));
                }
            }
        }
    }
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{cell, handle, wiring};

    fn node(cell: u32) -> NodeHandle {
        NodeHandle::new(cell)
    }

    /// Each connection's source, whether it rises and where it starts.
    fn fades(order: &Order) -> Vec<(Seat, bool, Start)> {
        order
            .connections
            .iter()
            .map(|connection| (connection.source, connection.rising, connection.start))
            .collect()
    }

    #[test]
    fn the_longest_chain_sorts_on_a_small_stack() {
        // Each node hears the next, so the last goes first.
        let inputs: HashMap<Id, Vec<Input>> = (1..=Id::from(u16::MAX))
            .map(|id| {
                let next = (id < Id::from(u16::MAX)).then_some(Input::kept(id + 1));
                (id, next.into_iter().collect())
            })
            .collect();
        let order: Vec<_> = (1..=Id::from(u16::MAX)).collect();
        // A recursive sort would need megabytes of stack for this.
        let sorted = std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(move || sort(|id| inputs[&id].as_slice(), |_| true, &order))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(sorted, (1..=Id::from(u16::MAX)).rev().collect::<Vec<_>>());
    }

    #[test]
    fn only_a_change_brings_an_order() {
        let mut record = Record::new(4, 4);
        assert_eq!(record.take_changes(), None);
        record.add(node(1));
        record.add(node(2));
        assert_eq!(
            record.take_changes().map(|order| order.turns.len()),
            Some(2)
        );
        assert_eq!(record.take_changes(), None);
        assert_eq!(
            record.connect(node(1), node(3)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.connect(node(2), node(2)), Err(Rejection::Loop));
        assert_eq!(
            record.set_output(node(3), Batch::new(1)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(
            record.remove(node(3), Batch::new(1)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.take_changes(), None, "refusals change nothing");
        assert_eq!(record.connect(node(2), node(1)), Ok(()));
        let (turns, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            turns,
            [
                (Seat::Cell(cell(2)), vec![]),
                (Seat::Cell(cell(1)), vec![Seat::Cell(cell(2))])
            ]
        );
        record.set_output(node(1), Batch::new(1)).unwrap();
        assert!(record.take_changes().is_some());
        record.set_output(node(1), Batch::new(2)).unwrap();
        assert_eq!(record.take_changes(), None, "the output already hears it");
        assert!(!record.take_holds());
    }

    #[test]
    fn a_handle_of_an_older_generation_reaches_nothing() {
        let mut record = Record::new(4, 4);
        let (old, new) = (node(1), NodeHandle::new(handle(1, 1)));
        record.add(old);
        record.add(node(2));
        record.remove(old, Batch::new(1)).unwrap();
        assert!(!record.is_taken(cell(1)), "the cell is free at once");
        record.add(new);
        assert_eq!(record.connect(old, node(2)), Err(Rejection::UnknownTarget));
        assert_eq!(
            record.set_output(old, Batch::new(2)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(
            record.remove(old, Batch::new(2)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.connect(new, node(2)), Ok(()));
        assert!(record.is_taken(cell(1)));
    }

    #[test]
    fn a_new_connection_starts_silent_where_it_is_heard_and_full_where_it_is_not() {
        let mut record = Record::new(8, 4);
        for cell in 1..=3 {
            record.add(node(cell));
        }
        record.set_output(node(1), Batch::new(1)).unwrap();
        // Before any order, nothing is heard; the output always is.
        let first = record.take_changes().unwrap();
        assert_eq!(fades(&first), [(Seat::Cell(cell(1)), true, Start::Silent)]);
        // 1 is heard, 3 isn't.
        record.connect(node(2), node(1)).unwrap();
        record.connect(node(2), node(3)).unwrap();
        let second = record.take_changes().unwrap();
        let (turns, _) = wiring(&second);
        assert_eq!(
            turns,
            [
                (Seat::Cell(cell(2)), vec![]),
                (Seat::Cell(cell(1)), vec![Seat::Cell(cell(2))]),
                (Seat::Cell(cell(3)), vec![Seat::Cell(cell(2))])
            ]
        );
        assert_eq!(
            fades(&second),
            [
                (Seat::Cell(cell(2)), true, Start::Silent),
                (Seat::Cell(cell(2)), true, Start::Full),
                (Seat::Cell(cell(1)), true, Start::As(0)),
            ]
        );
        // Each connection carries on from its place in the order before, but where no one hears it.
        record.add(node(4));
        let third = record.take_changes().unwrap();
        let starts: Vec<_> = fades(&third)
            .into_iter()
            .map(|(_, _, start)| start)
            .collect();
        assert_eq!(starts, [Start::As(0), Start::Full, Start::As(2)]);
    }

    #[test]
    fn where_no_one_heard_a_node_its_inputs_start_where_they_head() {
        let mut record = Record::new(8, 4);
        for cell in 1..=3 {
            record.add(node(cell));
        }
        record.connect(node(1), node(2)).unwrap();
        record.take_changes();
        // Made and cut in one batch while no one heard 3, which then comes to be heard: 3 never hears 1.
        record.connect(node(1), node(3)).unwrap();
        record.disconnect(node(1), node(3), Batch::new(1)).unwrap();
        record.set_output(node(3), Batch::new(1)).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Seat::Cell(cell(1)), true, Start::Full),
                (Seat::Cell(cell(1)), false, Start::Silent),
                (Seat::Cell(cell(3)), true, Start::Silent),
            ]
        );
        // 2 heard 1 in full while no one heard 2; 1 goes as 2 comes to be heard, so 2 never hears it.
        record.remove(node(1), Batch::new(2)).unwrap();
        record.set_output(node(2), Batch::new(2)).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Seat::Exit(Exit::new(0)), false, Start::Silent),
                (Seat::Exit(Exit::new(0)), false, Start::As(1)),
                (Seat::Cell(cell(3)), false, Start::As(2)),
                (Seat::Cell(cell(2)), true, Start::Silent),
            ]
        );
    }

    #[test]
    fn the_output_set_to_the_node_it_hears_keeps_the_batch_s_other_changes() {
        let mut record = Record::new(4, 4);
        record.add(node(1));
        record.set_output(node(1), Batch::new(1)).unwrap();
        record.take_changes();
        record.add(node(2));
        record.set_output(node(1), Batch::new(2)).unwrap();
        let (turns, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!((turns.len(), heard), (2, vec![Seat::Cell(cell(1))]));
    }

    #[test]
    fn a_switched_output_fades_out_until_its_batch_comes_back_unless_heard_again() {
        let mut record = Record::new(4, 4);
        record.add(node(1));
        record.add(node(2));
        record.set_output(node(1), Batch::new(1)).unwrap();
        record.take_changes();
        assert!(!record.take_holds(), "nothing faded out");
        record.set_output(node(2), Batch::new(2)).unwrap();
        assert!(record.take_holds());
        let switched = record.take_changes().unwrap();
        assert_eq!(
            fades(&switched),
            [
                (Seat::Cell(cell(1)), false, Start::As(0)),
                (Seat::Cell(cell(2)), true, Start::Silent),
            ]
        );
        record.finish(Batch::new(2));
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Seat::Cell(cell(2))]);

        // Back before the fade is over: the earlier batch's return no longer takes it away.
        record.set_output(node(1), Batch::new(3)).unwrap();
        record.set_output(node(2), Batch::new(4)).unwrap();
        record.finish(Batch::new(3));
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Seat::Cell(cell(2)), Seat::Cell(cell(1))]);
        record.finish(Batch::new(4));
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Seat::Cell(cell(2))]);
    }

    #[test]
    fn a_disconnected_connection_fades_out_until_its_batch_comes_back_unless_connected_again() {
        let mut record = Record::new(4, 4);
        for cell in 1..=3 {
            record.add(node(cell));
        }
        record.connect(node(1), node(3)).unwrap();
        record.connect(node(2), node(3)).unwrap();
        record.set_output(node(3), Batch::new(1)).unwrap();
        record.take_changes();
        record.disconnect(node(1), node(3), Batch::new(2)).unwrap();
        assert!(record.take_holds());
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Seat::Cell(cell(1)), false, Start::As(0)),
                (Seat::Cell(cell(2)), true, Start::As(1)),
                (Seat::Cell(cell(3)), true, Start::As(2)),
            ]
        );
        record.finish(Batch::new(2));
        let (turns, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(turns[2], (Seat::Cell(cell(3)), vec![Seat::Cell(cell(2))]));

        // Back before the fade is over: it rises from where it got, and the batch's return no longer takes it away.
        record.disconnect(node(2), node(3), Batch::new(3)).unwrap();
        record.take_changes();
        record.connect(node(2), node(3)).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Seat::Cell(cell(2)), true, Start::As(0)),
                (Seat::Cell(cell(3)), true, Start::As(1)),
            ]
        );
        record.finish(Batch::new(3));
        assert_eq!(record.take_changes(), None);
    }

    #[test]
    fn a_fading_connection_neither_closes_a_loop_nor_orders_its_listener() {
        let mut record = Record::new(4, 4);
        record.add(node(1));
        record.add(node(2));
        record.connect(node(1), node(2)).unwrap();
        record.take_changes();
        record.disconnect(node(1), node(2), Batch::new(1)).unwrap();
        // As the page sees it, 2 no longer hears 1; while it fades, 2 hears 1 a block late.
        record.connect(node(2), node(1)).unwrap();
        let (turns, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            turns,
            [
                (Seat::Cell(cell(2)), vec![Seat::Cell(cell(1))]),
                (Seat::Cell(cell(1)), vec![Seat::Cell(cell(2))])
            ]
        );
        assert_eq!(
            record.connect(node(1), node(2)),
            Err(Rejection::Loop),
            "connected again, the fading one would close a loop"
        );
    }

    #[test]
    fn a_removed_node_plays_out_with_its_inputs_until_its_batch_comes_back() {
        let mut record = Record::new(4, 1);
        for cell in 1..=3 {
            record.add(node(cell));
        }
        record.connect(node(1), node(2)).unwrap();
        record.connect(node(2), node(3)).unwrap();
        record.set_output(node(3), Batch::new(1)).unwrap();
        record.take_changes();
        let removal = record.remove(node(2), Batch::new(2)).unwrap();
        assert_eq!(
            removal,
            Removal {
                cell: cell(2),
                exit: Exit::new(0)
            }
        );
        assert!(record.take_holds());
        let playing_out = record.take_changes().unwrap();
        assert_eq!(
            fades(&playing_out),
            [
                (Seat::Cell(cell(1)), true, Start::As(0)),
                (Seat::Exit(Exit::new(0)), false, Start::As(1)),
                (Seat::Cell(cell(3)), true, Start::As(2)),
            ]
        );
        // The exits double for a second node playing out.
        let next = record.remove(node(3), Batch::new(3)).unwrap();
        assert_eq!(
            next,
            Removal {
                cell: cell(3),
                exit: Exit::new(1)
            }
        );
        assert_eq!(record.exits(), 2);
        record.finish(Batch::new(2));
        let (turns, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            turns,
            [
                (Seat::Cell(cell(1)), vec![]),
                (Seat::Exit(Exit::new(1)), vec![])
            ]
        );
        assert_eq!(heard, [Seat::Exit(Exit::new(1))]);
        assert_eq!(
            record.remove(node(1), Batch::new(4)).unwrap().exit,
            Exit::new(0),
            "freed"
        );
        assert_eq!(record.live_handles(), []);
    }

    #[test]
    fn a_loop_only_through_a_node_playing_out_is_no_loop_and_its_listener_may_hear_it_a_block_late()
    {
        let mut record = Record::new(8, 4);
        for cell in 1..=3 {
            record.add(node(cell));
        }
        record.connect(node(1), node(2)).unwrap();
        record.connect(node(2), node(3)).unwrap();
        record.take_changes();
        record.remove(node(2), Batch::new(1)).unwrap();
        // The page sees no 2 any more, so no loop.
        assert_eq!(record.connect(node(3), node(1)), Ok(()));
        let (turns, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            turns,
            [
                (Seat::Cell(cell(3)), vec![Seat::Exit(Exit::new(0))]),
                (Seat::Cell(cell(1)), vec![Seat::Cell(cell(3))]),
                (Seat::Exit(Exit::new(0)), vec![Seat::Cell(cell(1))]),
            ]
        );
        assert_eq!(record.connect(node(1), node(3)), Err(Rejection::Loop));
    }
}
