// The floor is part of the schedule. A dish is not "done" when it leaves the
// pass; it is done when a server walks it to the table. These are the people
// whose pace the agent learns from, and the delay is measured, not assumed.

export const WAITERS = [
  { id: "w1", name: "Maya", section: "A", paceSec: 35 },
  { id: "w2", name: "Dev", section: "B", paceSec: 55 },
  { id: "w3", name: "Priya", section: "C", paceSec: 45 },
  { id: "w4", name: "Sam", section: "D", paceSec: 70 },
];

export function waiterForTable(tableNo) {
  return WAITERS[(tableNo - 1) % WAITERS.length];
}

export function summarizeWaiters(tickets) {
  const groups = new Map();
  for (const ticket of tickets) {
    if (!ticket.waiterId) continue;
    const entry = groups.get(ticket.waiterId) ?? {
      id: ticket.waiterId,
      name: ticket.waiterName,
      section: ticket.waiterSection ?? null,
      courses: 0,
      tables: new Set(),
      lagSum: 0,
      lagCount: 0,
      lateCourses: 0,
    };
    entry.courses += 1;
    entry.tables.add(ticket.tableNo);
    if (ticket.serveLagSec != null) {
      entry.lagSum += ticket.serveLagSec;
      entry.lagCount += 1;
      if (ticket.serveLagSec > 60) entry.lateCourses += 1;
    }
    groups.set(ticket.waiterId, entry);
  }
  return [...groups.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    section: entry.section,
    tables: entry.tables.size,
    courses: entry.courses,
    avgLagSec: entry.lagCount ? Math.round(entry.lagSum / entry.lagCount) : 0,
    lateCourses: entry.lateCourses,
    onTimePct: entry.courses ? Math.round(((entry.courses - entry.lateCourses) / entry.courses) * 1000) / 10 : 0,
  }));
}
