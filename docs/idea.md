# Fireline — idea selection, edge cases, and limits

## 1. Testing the ideas against the judges' brief

DoorDash's judges asked for a merchant workflow, a tablet is a fair assumption, and
explicit reasoning about what the AI can and cannot do. They also warned that a
well-explained process is a legitimate output. That rules out another inventory or
bookkeeping dashboard: DoorDash already ships pieces of those, and another team is
building one this weekend.

| Idea | Pain point | Crowded? | Decision surface | Can we measure it? | Verdict |
|---|---|---|---|---|---|
| Inventory / invoice reconciliation | Back house | Very | Data extraction + matching | Yes | Skip — crowded, weak differentiator |
| Order packing verification | Front house | Some | Vision checks | Needs a camera | Skip — hardware demo risk |
| **When to fire each ticket** | Front house #1 | **No** (DoorDash gives an ETA, not a per-ticket start decision) | One time per ticket | **Yes** — replay the same shift with two policies | **Build** |
| Staffing / skill mix | Back house | High (7shifts et al.) | Roster | Needs labour data | Skip |
| Generic kitchen chatbot | Both | Very | Conversation | Not measurable | Skip |

Fireline answers one question the kitchen actually argues about: *this ticket, right
now — start it or hold it?* The AI is a decision policy, not a text generator.

## 2. What the agent does

Per waiting ticket, every four seconds:

1. Forecasts prep time for the ticket's critical station from learned per-item
   service times, plus the **projected** queue at the candidate start time.
2. Forecasts the courier arrival: exact if assigned, otherwise the promise plus a
   learned arrival bias with a wide spread.
3. Prices a grid of start times: `expected sitting seconds × 1 + expected courier
   wait seconds × 5`.
4. Caps the start with a deadline guard: do not start so late that an 85th-percentile
   cook misses the courier.
5. Fires immediately when the kitchen is already saturated, because queueing behind
   yourself is never free.

## 3. Edge cases the replay covers

| Case | Where | Expected behaviour |
|---|---|---|
| Duplicate ticket id | Chaos shift | Second ticket dropped and counted |
| 86'd item | Chaos, by menu | Ticket blocked before any station load |
| Empty ticket | Chaos | Blocked with a reason, run continues |
| Promise already past | Chaos | Fires immediately |
| 12-item party order | Chaos | Critical path and backlog drive the decision |
| No courier assigned | Unassigned shift | Plans against promise + bias, wider spread |
| Couriers systematically late | Late couriers | Bias updates; plan shifts later |
| Cold start | Cold start shift | Menu priors only; error is measured, not hidden |
| Sustained overload | Surge shift | Saturation rule fires immediately; the honest result is that capacity, not scheduling, is the constraint |
| HTML in a note | Chaos | Escaped in the UI |
| Malformed API input | Server tests | 400 with a message, no crash |
| 40 KB request body | Server tests | 413 |
| Unknown scenario/policy/seed | Server tests | 400 |

## 4. What the numbers mean — and what they do not

The simulator freezes every ticket, prep duration and courier arrival up front, then
replays the identical shift under five policies. The *difference* between policies is
meaningful because it is paired and seeded. The absolute minutes are illustrative,
calibrated for a plausible fast-casual kitchen — not measured from a real one.

Known modelling limits, stated on purpose:

- One worker per station, FIFO queue, no changeovers, no dropped plates.
- Prep times are lognormal around learned means; the critical path ignores the
  correlation between stations.
- Courier arrival is normal around the promise, with a learned bias; real dispatch
  ETAs are worse behaved.
- Cost weights (1:5) are a policy choice. The Evidence tab prints them.
- The LLM is not in the decision path. It may only rewrite a brief from measured
  numbers, and its text is rejected if it invents one.

## 5. Demo script (3 minutes)

1. Run the **Friday rush** on adaptive. Play at 8×; point at the fire times counting
   down and the "why" panel for one ticket.
2. Switch to **Evidence**: same shift, five policies. Point at the cost column.
3. Open the **Chaos shift** and play to 0:30 — duplicate dropped, wings blocked,
   empty ticket blocked, past-due promise fired immediately.
4. Switch policy to **Fire on arrival** on the same shift; the sitting time jumps.
5. Close on the limits slide: cold start, saturation, and why there is no LLM in the
   loop.
