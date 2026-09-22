# Real-device test checklist — candidate exam portal

**This one cannot be automated.** `test/mobile_markup.sh` verifies the markup and
the API behaviour that mobile depends on (viewport, numeric keypads, real radio
inputs, 48px touch targets, 16px fields, server-side autosave and resume,
submission locking), but it cannot tell you what the page actually looks like or
feels like under a thumb. Someone has to walk through the list below on each
device before go-live.

## Setup

1. Deploy, or expose your dev server on the LAN / a tunnel, and set
   `PUBLIC_EXAM_BASE_URL` so generated links point at a host the phone can
   reach. `localhost` links will not work on a phone.
2. In `/admin`, create three test candidates (or use **Data Management → Create
   Demo Candidates**) and generate one link each.
3. Send each link to the device you are testing on — the link must be opened on
   the real device, not in a desktop browser's device emulator.

Test on all three:

- [ ] Android Chrome (a mid-range phone, not just a flagship)
- [ ] iPhone Safari (ideally one with a notch, to check the safe-area padding)
- [ ] Desktop Chrome

## Per device

### Opening the link

- [ ] The link opens without a login prompt, from mobile data (not the office
      Wi-Fi), on a device that has never visited the admin app.
- [ ] The candidate's own name and position are shown, and nobody else's.
- [ ] The instructions and duration are readable without pinching.
- [ ] Nothing overflows sideways; there is no horizontal scrollbar.

### Identity verification

- [ ] The Candidate ID field accepts the code from the invitation.
- [ ] A wrong code is rejected with a clear message, not a crash.
- [ ] The on-screen keyboard does not cover the field you are typing into.

### Question display

- [ ] Question text is fully readable at the default zoom — no clipping.
- [ ] Long question text wraps rather than overflowing.
- [ ] The question counter ("Question 3 of 7") is visible.

### Radio buttons

- [ ] Tapping anywhere on an option row selects it, not just the small dot.
- [ ] The selected option is visually obvious (gold border / tint).
- [ ] Changing your mind deselects the previous option.

### Numeric answers

- [ ] Tapping a numeric field opens the **numeric keypad**, not the full QWERTY.
- [ ] A decimal point can be entered (e.g. `138.89`).
- [ ] **The page does not zoom in when a field is focused** — this is the most
      common iOS Safari failure; if it happens, the 16px field rule in
      `public/exam/index.html` has been overridden somewhere.
- [ ] After the keyboard closes, the layout returns to normal with no gap at the
      bottom.

### Written (essay) answer

- [ ] The textarea is large enough to see several lines while typing.
- [ ] Scrolling inside the textarea works without scrolling the whole page.
- [ ] Text is not lost when the keyboard opens/closes or the phone rotates.

### Timer

- [ ] The countdown is visible at the top on every screen and ticks each second.
- [ ] It turns red when time is low.
- [ ] **Lock the phone for one minute, then unlock**: the timer shows the real
      remaining time, not a minute more. (The deadline is the server's
      `expiresAt`, not a device-side counter.)
- [ ] Changing the phone's clock does not change the remaining time.

### Next / Previous

- [ ] Both buttons are reachable with a thumb and are not covered by the
      keyboard or the home indicator.
- [ ] Going back shows the answer you previously entered, still filled in.
- [ ] The last question's button reads "Review Answers".

### Auto-save (the important one)

- [ ] Answer two questions, then **force-quit the browser** and reopen the link:
      the assessment resumes with both answers still present.
- [ ] Turn on airplane mode mid-answer, type, then turn it back on: typing
      continues and the answer saves once connectivity returns.
- [ ] Switch to another app for a minute and come back: the session is intact.

### Submit

- [ ] The review screen lists every question and flags any left unanswered.
- [ ] Submitting shows a clear confirmation screen with the submission time.
- [ ] Reloading after submission shows the confirmation again — not the exam,
      and not an error.
- [ ] Tapping the browser's back button after submitting cannot re-enter the
      exam.

### Confirmation

- [ ] The confirmation text is complete and readable on a small screen.
- [ ] The candidate is told what happens next.

## Cross-device check

- [ ] Run all three candidates at the same time, one per device.
- [ ] Each device only ever shows its own candidate's name and answers.
- [ ] After all three submit, `/admin` shows three separate result sets with the
      scores you expect.

## Record the result

| Device | OS / browser version | Date | Tester | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| Android phone | | | | | |
| iPhone | | | | | |
| Desktop | | | | | |
