# Translating Grady Set Go - Playout App

The interface text lives in one catalog file per language: `panel/locales/<code>.json`.
`panel/locales/_template.json` lists every English text of the app (regenerate it with `node tools/i18n/i18n.js extract`).

## File format

```json
{
  "_meta": { "code": "es", "name": "Español", "english_name": "Spanish", "tag": "es", "dir": "ltr" },
  "messages": {
    "Save": "Guardar",
    "Open {name}": "Abrir {name}",
    "{n} clip": { "one": "{n} clip", "many": "{n} clips", "other": "{n} clips" },
    "Open##verb": "Abrir"
  }
}
```

- The key is the English text. Translate the value.
- `{name}`, `{n}`, `{count}` ... are placeholders filled in by the program. Keep every placeholder exactly as written; you may move it to where the grammar of your language needs it.
- Keys with `##word` are a context hint (`Open##verb` = the verb "Open"). The translation does not include the `##word` part.
- Plural entries are objects with one text per plural form of the language (CLDR categories: zero, one, two, few, many, other). In the template they appear as `{"_many": "..."}`: the key is the English singular and `_many` is the English plural. Replace the object by the forms your language needs. `{n}` is the number.
- Leading or trailing spaces and punctuation such as " · " or "…" are part of the text. Keep them where the sentence needs them (the program places such texts next to other texts).
- `dd`, `mm`, `yy`, `yyyy` with context `date` are the letters shown in date fields (for example `tt`, `mm`, `jj` in German).
- Do not translate product and technical names: ffplayout, FFmpeg, VLC, HLS, RTMP, SRT, YouTube, MusicBrainz, Wikidata, LUFS, true peak notation, file extensions, keyboard keys written as single letters in shortcuts.
- Register: formal, concise, the wording of professional broadcast software. Use the usual broadcast terms of your language (playlist, as-run log, slate, filler, ident, live slot).
- A missing or empty entry shows the English text, so nothing breaks while a language is incomplete.

## Checking

```
node tools/i18n/i18n.js check          # missing texts, wrong placeholders, wrong plural forms
node tools/i18n/i18n.js sync <code>    # add new texts of the template to a catalog
```

A language can also be added without touching the program: put `<code>.json` into `data/locales/` (it survives updates and may override single texts of a shipped language).
