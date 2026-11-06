//! The build thread's record of the graph the audio thread will have once every parcel sent is applied: live nodes
//! by cell, removed ones still playing out, what each hears and what the output hears. It changes only through these
//! methods, and each notes the change, so a batch sends the audio thread a new order exactly when it changed the
//! graph.

use std::collections::{HashMap, HashSet};
use std::mem;

use crate::graph::{Connection, Order, Place, Start, Step};
use crate::handle::NodeHandle;
use crate::schema::Rejection;

/// Never reused, unlike cells and places.
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
    fading_since: Option<u32>,
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
    fn goes(&self, batch: u32, gone: &HashSet<Id>) -> bool {
        self.fading_since == Some(batch) || gone.contains(&self.source)
    }
}

#[derive(Clone, Copy)]
enum State {
    Live {
        cell: u32,
    },
    /// Removed; plays out at the place until the parcel of the batch that removed it comes back.
    Leaving {
        place: u32,
    },
}

/// What the last order sent holds, for the next one to start from.
#[derive(Default)]
struct Sent {
    /// Each connection by listener (`None` for the output) and source, at its index in the order.
    connections: HashMap<(Option<Id>, Id), u32>,
    /// Every node the output heard through it, however far upstream.
    heard: HashSet<Id>,
}

/// A removed node's way out of its cell.
#[derive(Debug, PartialEq)]
pub(super) struct Removal {
    pub cell: u32,
    pub place: u32,
}

pub(super) struct Record {
    /// Live nodes by cell.
    cells: Vec<Option<Id>>,
    free_places: Vec<u32>,
    places: usize,
    entries: HashMap<Id, Entry>,
    /// Nodes playing out, by the batch that removed them.
    leaving: HashMap<u32, Vec<Id>>,
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
    pub fn new(cells: usize, places: usize) -> Self {
        Self {
            cells: vec![None; cells],
            free_places: (0..places as u32).rev().collect(),
            places,
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
    pub fn cells(&self) -> usize {
        self.cells.len()
    }

    /// The size of the audio thread's table of places.
    pub fn places(&self) -> usize {
        self.places
    }

    /// Under this very handle.
    pub fn has_live(&self, handle: NodeHandle) -> bool {
        self.live(handle).is_some()
    }

    /// Whatever the generation.
    pub fn is_taken(&self, cell: u32) -> bool {
        self.cells.get(cell as usize).is_some_and(Option::is_some)
    }

    /// Room for `cell`, doubling; the audio thread's table grows in the same parcel.
    pub fn make_room(&mut self, cell: u32) {
        if cell as usize >= self.cells.len() {
            self.cells
                .resize((cell as usize + 1).next_power_of_two(), None);
        }
    }

    /// A node that hears nothing yet, in a free cell of the table.
    pub fn add(&mut self, handle: NodeHandle) {
        debug_assert!(!self.is_taken(handle.cell()));
        let id = self.next_id;
        self.next_id += 1;
        let cell = handle.cell();
        self.cells[cell as usize] = Some(id);
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
    pub fn connect(&mut self, from: NodeHandle, to: NodeHandle) -> Result<(), Rejection> {
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
    pub fn disconnect(
        &mut self,
        from: NodeHandle,
        to: NodeHandle,
        batch: u32,
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
    pub fn set_output(&mut self, handle: NodeHandle, batch: u32) -> Result<(), Rejection> {
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
    pub fn remove(&mut self, handle: NodeHandle, batch: u32) -> Result<Removal, Rejection> {
        let id = self.live(handle).ok_or(Rejection::UnknownTarget)?;
        let cell = handle.cell();
        if self.free_places.is_empty() {
            self.grow_places();
        }
        let Some(place) = self.free_places.pop() else {
            unreachable!("the places just grew");
        };
        self.cells[cell as usize] = None;
        if let Some(entry) = self.entries.get_mut(&id) {
            entry.state = State::Leaving { place };
        }
        self.leaving.entry(batch).or_default().push(id);
        for heard in &mut self.output {
            if heard.source == id && heard.is_kept() {
                heard.fading_since = Some(batch);
            }
        }
        self.changed = true;
        self.holds = true;
        Ok(Removal { cell, place })
    }

    /// Every live node, as a reset removes them.
    pub fn live_handles(&self) -> Vec<NodeHandle> {
        self.cells
            .iter()
            .flatten()
            .map(|id| self.entries[id].handle)
            .collect()
    }

    /// Forgets what the batch faded out: its parcel came back, so that is silent and back on this thread.
    pub fn finish(&mut self, batch: u32) {
        let gone: HashSet<Id> = self
            .leaving
            .remove(&batch)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for id in &gone {
            if let Some(Entry {
                state: State::Leaving { place, .. },
                ..
            }) = self.entries.remove(id)
            {
                self.free_places.push(place);
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
    pub fn take_holds(&mut self) -> bool {
        mem::take(&mut self.holds)
    }

    /// What the audio thread renders, in order, what each node hears and what the output hears, if the graph changed
    /// since the last call.
    pub fn take_changes(&mut self) -> Option<Order> {
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
        let mut steps = Vec::with_capacity(self.order.len());
        for &id in &self.order {
            let first = connections.len() as u32;
            for input in self.inputs(id) {
                sent.connections
                    .insert((Some(id), input.source), connections.len() as u32);
                connections.push(self.connection(Some(id), input));
            }
            steps.push(Step {
                node: self.place(id),
                inputs: (first, connections.len() as u32),
            });
        }
        let output = connections.len() as u32;
        for heard in &self.output {
            sent.connections
                .insert((None, heard.source), connections.len() as u32);
            connections.push(self.connection(None, heard));
        }
        sent.heard = self.upstream(self.output.iter().map(|heard| heard.source), |_| true);
        self.sent = sent;
        Some(Order {
            steps: steps.into(),
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
        Connection::new(self.place(input.source), rising, start)
    }

    fn place(&self, id: Id) -> Place {
        match self.entries[&id].state {
            State::Live { cell } => Place::Cell(cell),
            State::Leaving { place, .. } => Place::Leaving(place),
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
        let id = (*self.cells.get(handle.cell() as usize)?)?;
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

    /// Doubles the table of places; the audio thread's grows in the same parcel.
    fn grow_places(&mut self) {
        let places = (self.places * 2).max(1);
        self.free_places
            .extend((self.places as u32..places as u32).rev());
        self.places = places;
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
    use crate::handle::MAX_CELL;

    fn handle(cell: u32) -> NodeHandle {
        NodeHandle::new(cell)
    }

    /// Each step's node with its inputs as places, and the output's.
    fn wiring(order: &Order) -> (Vec<(Place, Vec<Place>)>, Vec<Place>) {
        let sources = |range: std::ops::Range<usize>| {
            order.connections[range]
                .iter()
                .map(|connection| connection.source)
                .collect::<Vec<_>>()
        };
        let steps = order
            .steps
            .iter()
            .map(|step| {
                (
                    step.node,
                    sources(step.inputs.0 as usize..step.inputs.1 as usize),
                )
            })
            .collect();
        (
            steps,
            sources(order.output as usize..order.connections.len()),
        )
    }

    /// Each connection's source, whether it rises and where it starts.
    fn fades(order: &Order) -> Vec<(Place, bool, Start)> {
        order
            .connections
            .iter()
            .map(|connection| (connection.source, connection.rising, connection.start))
            .collect()
    }

    #[test]
    fn the_longest_chain_sorts_on_a_small_stack() {
        // Each node hears the next, so the last goes first.
        let inputs: HashMap<Id, Vec<Input>> = (1..=Id::from(MAX_CELL))
            .map(|id| {
                let next = (id < Id::from(MAX_CELL)).then_some(Input::kept(id + 1));
                (id, next.into_iter().collect())
            })
            .collect();
        let order: Vec<_> = (1..=Id::from(MAX_CELL)).collect();
        // A recursive sort would need megabytes of stack for this.
        let sorted = std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(move || sort(|id| inputs[&id].as_slice(), |_| true, &order))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(sorted, (1..=Id::from(MAX_CELL)).rev().collect::<Vec<_>>());
    }

    #[test]
    fn only_a_change_brings_an_order() {
        let mut record = Record::new(4, 4);
        assert_eq!(record.take_changes(), None);
        record.add(handle(1));
        record.add(handle(2));
        assert_eq!(
            record.take_changes().map(|order| order.steps.len()),
            Some(2)
        );
        assert_eq!(record.take_changes(), None);
        assert_eq!(
            record.connect(handle(1), handle(3)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.connect(handle(2), handle(2)), Err(Rejection::Loop));
        assert_eq!(
            record.set_output(handle(3), 1),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.remove(handle(3), 1), Err(Rejection::UnknownTarget));
        assert_eq!(record.take_changes(), None, "refusals change nothing");
        assert_eq!(record.connect(handle(2), handle(1)), Ok(()));
        let (steps, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            steps,
            [
                (Place::Cell(2), vec![]),
                (Place::Cell(1), vec![Place::Cell(2)])
            ]
        );
        record.set_output(handle(1), 1).unwrap();
        assert!(record.take_changes().is_some());
        record.set_output(handle(1), 2).unwrap();
        assert_eq!(record.take_changes(), None, "the output already hears it");
        assert!(!record.take_holds());
    }

    #[test]
    fn a_handle_of_an_older_generation_reaches_nothing() {
        let mut record = Record::new(4, 4);
        let (old, new) = (handle(1), NodeHandle::new(1 << 16 | 1));
        record.add(old);
        record.add(handle(2));
        record.remove(old, 1).unwrap();
        assert!(!record.is_taken(1), "the cell is free at once");
        record.add(new);
        assert_eq!(
            record.connect(old, handle(2)),
            Err(Rejection::UnknownTarget)
        );
        assert_eq!(record.set_output(old, 2), Err(Rejection::UnknownTarget));
        assert_eq!(record.remove(old, 2), Err(Rejection::UnknownTarget));
        assert_eq!(record.connect(new, handle(2)), Ok(()));
        assert!(record.is_taken(1));
    }

    #[test]
    fn a_new_connection_starts_silent_where_it_is_heard_and_full_where_it_is_not() {
        let mut record = Record::new(8, 4);
        for cell in 1..=3 {
            record.add(handle(cell));
        }
        record.set_output(handle(1), 1).unwrap();
        // Before any order, nothing is heard; the output always is.
        let first = record.take_changes().unwrap();
        assert_eq!(fades(&first), [(Place::Cell(1), true, Start::Silent)]);
        // 1 is heard, 3 isn't.
        record.connect(handle(2), handle(1)).unwrap();
        record.connect(handle(2), handle(3)).unwrap();
        let second = record.take_changes().unwrap();
        let (steps, _) = wiring(&second);
        assert_eq!(
            steps,
            [
                (Place::Cell(2), vec![]),
                (Place::Cell(1), vec![Place::Cell(2)]),
                (Place::Cell(3), vec![Place::Cell(2)])
            ]
        );
        assert_eq!(
            fades(&second),
            [
                (Place::Cell(2), true, Start::Silent),
                (Place::Cell(2), true, Start::Full),
                (Place::Cell(1), true, Start::As(0)),
            ]
        );
        // Each connection carries on from its place in the order before, but where no one hears it.
        record.add(handle(4));
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
            record.add(handle(cell));
        }
        record.connect(handle(1), handle(2)).unwrap();
        record.take_changes();
        // Made and cut in one batch while no one heard 3, which then comes to be heard: 3 never hears 1.
        record.connect(handle(1), handle(3)).unwrap();
        record.disconnect(handle(1), handle(3), 1).unwrap();
        record.set_output(handle(3), 1).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Place::Cell(1), true, Start::Full),
                (Place::Cell(1), false, Start::Silent),
                (Place::Cell(3), true, Start::Silent),
            ]
        );
        // 2 heard 1 in full while no one heard 2; 1 goes as 2 comes to be heard, so 2 never hears it.
        record.remove(handle(1), 2).unwrap();
        record.set_output(handle(2), 2).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Place::Leaving(0), false, Start::Silent),
                (Place::Leaving(0), false, Start::As(1)),
                (Place::Cell(3), false, Start::As(2)),
                (Place::Cell(2), true, Start::Silent),
            ]
        );
    }

    #[test]
    fn a_switched_output_fades_out_until_its_batch_comes_back_unless_heard_again() {
        let mut record = Record::new(4, 4);
        record.add(handle(1));
        record.add(handle(2));
        record.set_output(handle(1), 1).unwrap();
        record.take_changes();
        assert!(!record.take_holds(), "nothing faded out");
        record.set_output(handle(2), 2).unwrap();
        assert!(record.take_holds());
        let switched = record.take_changes().unwrap();
        assert_eq!(
            fades(&switched),
            [
                (Place::Cell(1), false, Start::As(0)),
                (Place::Cell(2), true, Start::Silent),
            ]
        );
        record.finish(2);
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Place::Cell(2)]);

        // Back before the fade is over: the earlier batch's return no longer takes it away.
        record.set_output(handle(1), 3).unwrap();
        record.set_output(handle(2), 4).unwrap();
        record.finish(3);
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Place::Cell(2), Place::Cell(1)]);
        record.finish(4);
        let (_, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(heard, [Place::Cell(2)]);
    }

    #[test]
    fn a_disconnected_connection_fades_out_until_its_batch_comes_back_unless_connected_again() {
        let mut record = Record::new(4, 4);
        for cell in 1..=3 {
            record.add(handle(cell));
        }
        record.connect(handle(1), handle(3)).unwrap();
        record.connect(handle(2), handle(3)).unwrap();
        record.set_output(handle(3), 1).unwrap();
        record.take_changes();
        record.disconnect(handle(1), handle(3), 2).unwrap();
        assert!(record.take_holds());
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Place::Cell(1), false, Start::As(0)),
                (Place::Cell(2), true, Start::As(1)),
                (Place::Cell(3), true, Start::As(2)),
            ]
        );
        record.finish(2);
        let (steps, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(steps[2], (Place::Cell(3), vec![Place::Cell(2)]));

        // Back before the fade is over: it rises from where it got, and the batch's return no longer takes it away.
        record.disconnect(handle(2), handle(3), 3).unwrap();
        record.take_changes();
        record.connect(handle(2), handle(3)).unwrap();
        assert_eq!(
            fades(&record.take_changes().unwrap()),
            [
                (Place::Cell(2), true, Start::As(0)),
                (Place::Cell(3), true, Start::As(1)),
            ]
        );
        record.finish(3);
        assert_eq!(record.take_changes(), None);
    }

    #[test]
    fn a_fading_connection_neither_closes_a_loop_nor_orders_its_listener() {
        let mut record = Record::new(4, 4);
        record.add(handle(1));
        record.add(handle(2));
        record.connect(handle(1), handle(2)).unwrap();
        record.take_changes();
        record.disconnect(handle(1), handle(2), 1).unwrap();
        // As the page sees it, 2 no longer hears 1; while it fades, 2 hears 1 a block late.
        record.connect(handle(2), handle(1)).unwrap();
        let (steps, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            steps,
            [
                (Place::Cell(2), vec![Place::Cell(1)]),
                (Place::Cell(1), vec![Place::Cell(2)])
            ]
        );
        assert_eq!(
            record.connect(handle(1), handle(2)),
            Err(Rejection::Loop),
            "connected again, the fading one would close a loop"
        );
    }

    #[test]
    fn a_removed_node_plays_out_with_its_inputs_until_its_batch_comes_back() {
        let mut record = Record::new(4, 1);
        for cell in 1..=3 {
            record.add(handle(cell));
        }
        record.connect(handle(1), handle(2)).unwrap();
        record.connect(handle(2), handle(3)).unwrap();
        record.set_output(handle(3), 1).unwrap();
        record.take_changes();
        let removal = record.remove(handle(2), 2).unwrap();
        assert_eq!(removal, Removal { cell: 2, place: 0 });
        assert!(record.take_holds());
        let playing_out = record.take_changes().unwrap();
        assert_eq!(
            fades(&playing_out),
            [
                (Place::Cell(1), true, Start::As(0)),
                (Place::Leaving(0), false, Start::As(1)),
                (Place::Cell(3), true, Start::As(2)),
            ]
        );
        // The places double for a second node playing out.
        let next = record.remove(handle(3), 3).unwrap();
        assert_eq!(next, Removal { cell: 3, place: 1 });
        assert_eq!(record.places(), 2);
        record.finish(2);
        let (steps, heard) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            steps,
            [(Place::Cell(1), vec![]), (Place::Leaving(1), vec![])]
        );
        assert_eq!(heard, [Place::Leaving(1)]);
        assert_eq!(record.remove(handle(1), 4).unwrap().place, 0, "freed");
        assert_eq!(record.live_handles(), []);
    }

    #[test]
    fn a_loop_only_through_a_node_playing_out_is_no_loop_and_its_listener_may_hear_it_a_block_late()
    {
        let mut record = Record::new(8, 4);
        for cell in 1..=3 {
            record.add(handle(cell));
        }
        record.connect(handle(1), handle(2)).unwrap();
        record.connect(handle(2), handle(3)).unwrap();
        record.take_changes();
        record.remove(handle(2), 1).unwrap();
        // The page sees no 2 any more, so no loop.
        assert_eq!(record.connect(handle(3), handle(1)), Ok(()));
        let (steps, _) = wiring(&record.take_changes().unwrap());
        assert_eq!(
            steps,
            [
                (Place::Cell(3), vec![Place::Leaving(0)]),
                (Place::Cell(1), vec![Place::Cell(3)]),
                (Place::Leaving(0), vec![Place::Cell(1)]),
            ]
        );
        assert_eq!(record.connect(handle(1), handle(3)), Err(Rejection::Loop));
    }
}
