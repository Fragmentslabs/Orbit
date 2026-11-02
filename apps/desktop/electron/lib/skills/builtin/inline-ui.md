---
name: Inline visuals
description: Orbit-ui blocks inside the answer — stats, charts, tables, compare, checklists, steps, buttons and live calculators/simulators with inputs and formulas. Read before writing an orbit-ui block.
slug: inline_ui
---

ORBIT-UI BLOCKS. A ```orbit-ui fence draws ready-made Orbit components, ONE JSON object per line (JSON Lines, not an array), so each piece appears as soon as you finish writing its line. Available "type"s:
- stats: {"type":"stats","items":[{"label":"MRR","value":"R$ 12k","delta":"+8%","trend":"up","hint":"vs. last month"}]} (1-6 items; trend is up|down|flat)
Keep stats short: label up to ~3 words, value a compact number (use |compact, |0 or |brl rather than long decimals), hint a few words — the cards are narrow, and long text wraps and shrinks.
- callout: {"type":"callout","tone":"info|success|warning|danger","title":"optional","text":"..."}
- steps: {"type":"steps","items":[{"title":"...","text":"optional","status":"done|active|todo"}]}
- table: {"type":"table","columns":["A","B"],"rows":[["x",1],["y",2]]}
- chart: {"type":"chart","kind":"bar|line|area|pie","title":"optional","unit":"optional","data":[{"label":"Jan","value":10}]}
- checklist: {"type":"checklist","items":[{"text":"...","done":true}]}
- compare: {"type":"compare","items":[{"title":"Option A","tag":"optional","points":["..."]}]} (2-4 items)
- kv: {"type":"kv","items":[{"label":"Plan","value":"Pro"}]}
- progress: {"type":"progress","items":[{"label":"Storage","value":72,"hint":"72 of 100 GB"}]} (value 0-100)
- slider: {"type":"slider","id":"rate","label":"Interest","min":0,"max":20,"value":8,"unit":"%"}   number: {"type":"number","id":"capital","label":"Capital","value":1000}   select: {"type":"select","id":"plan","label":"Plan","options":["Free","Pro"]} (or options as {"label":"Pro","value":29})   tabs: {"type":"tabs","id":"view","options":["Monthly","Yearly"]}   toggle: {"type":"toggle","id":"tax","label":"Include tax"}   text: {"type":"text","id":"name","label":"Name"}
- buttons: {"type":"buttons","items":[{"label":"Break it down","action":"send","text":"Break down scenario B step by step"},{"label":"Copy","action":"copy","text":"..."},{"label":"Yearly","action":"set","id":"view","value":"Yearly"}]} — "send" posts that text as the user's next message (use it for follow-up suggestions the user is likely to want), "copy" copies it, "set" changes an input's value.
- nav: {"type":"nav","destination":"voice","note":"Leitura em voz alta, ditado e modelos de voz"} — a card that takes the user to a screen of the app with one click. Use it whenever the answer is "where do I enable/change X?" — the user is looking at the app, so show the door instead of describing it.

INTERACTIVITY. Inputs (slider, number, select, tabs, toggle, text) each have an "id" — the id is a variable. Put the inputs FIRST, then components that depend on them, and everything reacts live as the user changes a value, with no further calls:
- EVERY computed value needs its curly braces — the braces are what makes it a formula. A stats value is {"type":"stats","items":[{"label":"Final","value":"{capital*pow(1+rate/100,years)|brl}"}]}, NOT "value":"capital*pow(1+rate/100,years)|brl" (that prints the formula as text). The braces wrap the whole formula including the |format.
- In ANY text field write {expression} to insert a computed value, optionally formatted: {capital*(1+rate/100)^years|0} (|0..4 = decimals, |compact, |brl, |usd, |eur, |pct). Table cells, stats values, labels, callout text all accept it.
- Numeric fields accept an expression instead of a number: progress "value":"used/total*100", chart data "value":"capital*rate/100".
- A chart can be a function instead of points: {"type":"chart","kind":"line","title":"Growth","x":[0,30],"steps":31,"xLabel":"years","fns":[{"name":"Saving","fn":"capital*(1+rate/100)^x"},{"name":"Cash","fn":"capital"}]} — "x" is the variable; up to 4 functions are drawn together.
- "showIf":"view=='Yearly'" (text uses single quotes inside expressions) on any component shows it only while the condition holds (tabs, scenarios, optional detail).
Expressions support numbers, "text", + - * / % ^, comparisons, && || !, if(cond,a,b), min max abs round(x,d) floor ceil sqrt pow log exp clamp(x,lo,hi) sum avg pmt(rate,periods,pv), and the constants pi, e, true, false. Nothing else exists — no JavaScript, no other variables. Use it for calculators, simulators, comparisons and filters; a tool that needs real code, many screens or persistence is a create_artifact.

Write real data only — never invent numbers to fill a chart. Put the lines inside ONE fence, each object complete on a single line, and write your usual prose around it: the block replaces the table/list that would be hard to read as text, not the explanation.
