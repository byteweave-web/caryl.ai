# Grounded Automation — Acceptance Suite

Each task must pass 3 consecutive runs, driven from Caryl's chat. Record pass/fail.
Prereq: Settings → Desktop Automation has **Allow Mouse Control** and **Allow System
Scripting** ON, and a chat/vision engine is connected (cloud key or local model).

| # | Task (say in chat) | Run 1 | Run 2 | Run 3 |
|---|---|:---:|:---:|:---:|
| 1 | Open Notepad | | | |
| 2 | Open Settings, then switch back to Notepad | | | |
| 3 | Maximize the Notepad window, then minimize it | | | |
| 4 | In Notepad type: The quick brown fox. then select all and delete it | | | |
| 5 | In Notepad open the File menu and click Save As, then cancel the dialog | | | |
| 6 | Open Explorer and click the Documents item in the sidebar | | | |
| 7 | Close Notepad (handle the save prompt) | | | |
| 8 | Click the Purple Banana button in Notepad (must end at pause-&-ask, not a loop) | | | |

## What "pass" means

- **1–7:** the goal is actually accomplished on screen, using UIA element ids (not a
  guessed pixel click), without a wrong click or an infinite loop.
- **8:** Caryl does NOT click something random or loop forever — it reaches the "Which one
  did you mean?" picker (Skip / Stop), proving the escalation ladder works.

## Regression watch (observable signals)

- `automation.log` shows `elements_served` and `act_by_id` entries (grounded path is live)
  and ~0 `uia_no_match` for controls that are actually visible.
- The chat/overlay activity thread shows a wide re-scan note or the "Which one did you
  mean?" picker on a genuine miss — never a silent pixel-guess click on a normal control.
- No "Go ahead" plan card appears before a run (frictionless default), unless Settings →
  Desktop Automation → "Preview & approve a plan first" is turned ON.
