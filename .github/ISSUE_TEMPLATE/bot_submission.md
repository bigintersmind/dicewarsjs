---
name: Bot Submission
about: Submit a bot to the DiceWarsJS community
title: '[Bot] '
labels: bot-submission
assignees: ''
---

## Bot Name

Your bot's name.

## Strategy Description

Explain how your bot makes decisions. What's its general approach?

## Source Code

Paste your bot function below. It should accept a `state` parameter and return `{ from, to }` to attack or `null` to end the turn.

```javascript
// Your bot code here — receives `state`, return { from, to } or null
const myAreas = state.myAreas.filter(a => a.dice > 1);
// ... your strategy logic ...
return { from: attackerId, to: defenderId };
```

## Performance

If you've tested it, how does it perform against the built-in bots?

## Additional Notes

Anything else about your bot (inspirations, known weaknesses, etc.).
