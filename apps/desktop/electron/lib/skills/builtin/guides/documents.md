---
name: Documents
description: How to write Orbit documents, edit an attached .docx and work with existing PDFs.
slug: orbit_documents
---

DOCUMENTS. create_document({ title, markdown }) writes a document in Markdown — it shows up in your response, where the user reads it and downloads it as PDF or DOCX if they want, and it is saved to the media gallery.

Use it when the user asks for a document, a report, documentation, a proposal, minutes, a specification, or literally "a PDF"/"a Word file". Do NOT use it for an answer that belongs in the chat, for source code (that is write/edit), for a dashboard or prototype (that is create_artifact — an HTML page, not a document), or to change a Word file the user attached (that is docx_edit, which keeps its formatting).

- The source is Markdown and the rendering is ours: headings (# ## ###), lists, tables, quotes, **bold**, *italic*, `code`, fenced code blocks with ``` (write the language right after the opening fence — nothing inside is interpreted as Markdown), --- for a rule, a line containing only \pagebreak for a page break, and <br> for a blank line inside a paragraph (useful for answer space on a form or a test).
- Emphasis is ONLY with asterisks. Underscores are left alone on purpose, so a fill-in line ("Nome: ______") survives intact.
- No other HTML is interpreted: <b>, <div>, <table> and the like appear literally in the document. Everything you want formatted goes through the Markdown above.
- Do NOT pass `formats`. The document IS the Markdown, and the card already offers PDF and DOCX for download. Pass `formats` only when the user explicitly asked for a file — "make this a PDF", "send it to me in Word", or they said they will print it or e-mail it — and then only the format they asked for.
- You can customize the look with `style`: fontFamily, fontSize, accentColor (hex), marginCm, columns (1 to 3, whole document) and align. It applies to BOTH the PDF and the DOCX. Use it when the user asks for a look, or when the document type calls for one — a proposal is not a school test. Do not restyle on every edit: update_document keeps the existing style when you omit it.
- Table column alignment comes from the divider row: |:---| left, |:---:| centred, |---:| right. Use right for numbers and money.
- Before writing something that may already exist, call list_documents — by default it lists the documents of THIS project, including ones made in earlier conversations about the same folder. Updating beats creating a near-duplicate.
- To change an existing document, call read_document first and then update_document with the full new Markdown. Rewriting from memory silently drops whatever you had forgotten.
- THE USER EDITS THESE DOCUMENTS TOO, in the side panel, while you work. read_document reports a revision; pass it back as `baseRevision`. If the document moved on, the write is REFUSED and nothing is lost — read it again, reapply your change on top of what comes back, and write again. Never answer a refusal by repeating the same rewrite: that is exactly the edit that would erase their work.
- After creating it, do not paste the content again as text: the user is already looking at it.

EDITING A .docx THE USER ATTACHED. docx_edit changes it and saves a COPY, which shows up in the conversation with a download button — the original file is never modified, and formatting survives because every change reuses what is already in the file. It replaces text, inserts paragraphs (cloning an existing one's style and list numbering), removes paragraphs, and adds or removes table rows (cloning an existing row's borders and column widths).
- NEVER rebuild an attached Word file with create_document to "edit" it, not even when the user later asks for "a docx": that throws away its fonts, table layout, header, numbering and page setup — exactly what they wanted kept. Edit the copy with docx_edit. If what they ask is beyond it (moving a section to another page, changing column widths, restyling the whole file), say so plainly and offer the choice: the part docx_edit can do, keeping the look, or a new document written from scratch, which will NOT look like the original.
- Call docx_paragraphs FIRST. Every anchor is literal: you need the text exactly as it is in the file, not as you remember or paraphrased it.
- The result reports which operations were not applied. Say so instead of implying the whole edit went through.
- Only pass savePath when the user explicitly asked to write into the working folder. By default the copy stays in Orbit and the user downloads it.
- An edit PRESERVES EVERYTHING the user did not ask to change: text colour (a black title stays black — never recolour headings or text, and never pick a "nicer" accent), fonts, sizes, header, footer, numbering, page setup. When content comes from another document (e.g. "use the header of file B"), copy it as it is in its source, including its colours and styles, instead of re-typing or restyling it. After editing, check that the result still matches the original on these points.
- For a document YOU wrote, use update_document — it keeps the Markdown source and the style.

WORKING WITH EXISTING PDFs. pdf_merge joins files; pdf_transform picks, REORDERS, rotates and stamps a watermark (pages take a range like "1-3,7", and the order you write is the order that comes out, so it also deletes and reorders); pdf_form_fields lists a form fields and pdf_form_fill fills them.
- Every one of these writes a NEW file that appears in the conversation with a download button. The source is never modified, and savePath only when the user explicitly asked.
- pdf_metadata reads the document properties; pdf_transform writes them. pdf_extract_images pulls the FIGURES out of the file into the gallery — different from pdf_view_page, which photographs the page.
- Before filling a form, call pdf_form_fields: fields are matched by their INTERNAL name, which is rarely the label printed next to the box. Flatten only when the form is being SENT.
