# ADR-0001: Where selected text goes when capturing a task

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** Marc Nelson

## Context

When you capture with the EisenQ extension, any text you have selected on the page is read and
put into the task. Today one rule decides where it goes (`extension/lib/page.js`, `buildCapture`):

> A selection of 120 characters or less becomes the **title**. A longer one goes to the **notes**,
> and the page title becomes the title.

The rule was written for one case: picking a single offer, such as "$3.99 Each Degree…", off a
page of offers, where the page title ("Offers | PC Optimum") says nothing useful.

It fails in real use:

- **Multi-line selections are mangled.** Selecting a block from an email,
  *Symbol: ANT / Requested: 2 shares / Price range: $70.00–$78.00 USD*, is under 120 characters,
  so it became the title. A title is a single line, so the line breaks disappeared and it read
  "…mbol: ANTRequested: 2 sharesPrice range…".
- **It overrides a good title.** On Gmail the email's subject is already a good title, and a
  selection replaced it.
- **It's unpredictable.** Whether the selection lands in the title or the notes depends on a
  character count you can't see. The user expected the selection in Notes, and had no way to tell
  in advance where it would go.

There are two ways to capture, and they say different things about the selection:

1. **Clicking the EisenQ icon** (or Alt+Shift+E) means *"capture this page."* Anything selected is
   supporting detail.
2. **Right-clicking a selection → Add to EisenQ ▸ Do First** means *"capture this text."* The
   selection *is* the task, and there's no form to fix a bad title in.

## Decision

Decide by **which gesture** was used, not by length:

- **Icon / shortcut / side panel:** the selection goes to **Notes**, line breaks intact. The title
  is the email subject or page title, which you can edit.
- **Right-click on a selection:** the selection is the task. Its **first line** becomes the title,
  trimmed at a word boundary if needed. When the selection has more than one line or doesn't fit
  in the title, the **whole selection** also goes in Notes, so nothing is lost.

In one sentence: *clicking the icon captures the page, and your selection becomes a note.
Right-clicking a selection captures that text.*

## Options Considered

### Option A: Keep the 120-character rule

| Dimension | Assessment |
|---|---|
| Complexity | Low (already built) |
| Predictability | Poor: depends on a hidden length |
| Gmail | Poor: the selection replaces a good subject |
| Offers page | Good: the offer becomes the title |
| Multi-line text | Broken: line breaks lost |

**Pros:** no work. **Cons:** produced the reported bug, and surprises the user.

### Option B: Selection always goes to Notes

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Predictability | Excellent: one rule everywhere |
| Gmail | Good |
| Offers page | Poor: the title becomes "Offers \| PC Optimum" |
| Right-click one-click capture | Poor: every task from a page shares the same generic title, with no form to fix it |

**Pros:** the simplest possible rule, and matches what the user expected in the panel.
**Cons:** makes right-click capture much worse, because the title is all you see in the matrix.

### Option C: Single-line short selections become the title, everything else goes to Notes

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Predictability | Fair: still a hidden rule |
| Gmail | Poor: a one-line selection still replaces the subject |
| Offers page | Good |
| Multi-line text | Fixed |

**Pros:** fixes the mangling with a one-line change. **Cons:** keeps the surprise the user
reported. Selecting "Price range: $70–$78" in the panel would still overwrite the subject.

### Option D: Decide by gesture (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low–medium: two small rules, one per entry point |
| Predictability | Good: each gesture has an obvious meaning |
| Gmail (icon) | Good: the subject stays the title, the selection is a note |
| Offers page (right-click) | Good: the offer becomes the title |
| Multi-line text | Fixed everywhere: line breaks kept in Notes |

**Pros:** fixes the reported case and keeps right-click capture useful. The rule maps onto
something the user did, not a number.
**Cons:** two rules instead of one. In the panel, a page with a vague title needs a manual title
edit. That edit is one click away, so the cost is small.

## Trade-off Analysis

The real tension is between **predictability** (Option B) and **good titles without a form**
(right-click capture). Option B wins on simplicity but quietly breaks one-click capture: on a page
full of offers, every task would be titled "Offers | PC Optimum". Option D keeps B's
predictability where there *is* a form to fix the title (the panel), and keeps the
selection-as-title behaviour only where the user explicitly pointed at the text and there's no form.

The 120-character threshold isn't kept anywhere. Its only job was to guess intent, and the gesture
states intent directly.

## Consequences

- **Easier:** explaining the extension ("icon = page, right-click = this text"), and capturing
  structured text such as order details, addresses or rate tables without losing its layout.
- **Harder:** nothing meaningful. Pages with vague titles need a quick title edit in the panel.
- **Revisit:** if vague page titles become a regular annoyance in the panel, let the AI date check
  also suggest a short title. It already reads the same text, so it would cost no extra call.

## Action Items

1. [x] `extension/lib/page.js`: replace the length rule with a `mode` argument
       (`"page"` | `"selection"`). Keep the selection's line breaks.
2. [x] Side panel and icon: capture in `"page"` mode, putting the selection in Notes.
3. [x] Right-click quadrant items: capture in `"selection"` mode. The first line becomes the title,
       trimmed at a word boundary to the server's 500-character limit. The full selection goes in
       Notes when it's longer or multi-line.
4. [ ] (Not done yet) Show the selected text in the right-click menu label, e.g. *Add "Symbol: ANT…" to
       EisenQ*, so it's clear the text is what gets filed.
5. [x] Update the extension README's "What becomes the title" paragraph.
