// Apple Notes reader for Seed Guard (JXA, run with `osascript -l JavaScript notes.jxa.js <count|export> [folder]`).
// With a folder name (demo mode), only folders with exactly that name are read.
// export streams one JSON line per folder to stdout; note text never touches the disk.
// Bulk property fetches per folder, as in notes-janitor's exporter: an order of magnitude faster than per-note calls.

ObjC.import('Foundation');

// Pure ASCII out: JSON.stringify leaves U+2028/U+2029 raw (web clippings have them), and Node's readline splits lines on them.
function writeLine(obj) {
  const json = JSON.stringify(obj).replace(/[\u007f-￿]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });
  const s = $.NSString.alloc.initWithUTF8String(json + '\n');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
}

function iso(dates) {
  return dates.map(function (d) { try { return d.toISOString(); } catch (e) { return null; } });
}

function run(argv) {
  const Notes = Application('Notes');
  const folders = [];
  const only = argv[1];
  Notes.accounts().forEach(function (acc) { acc.folders().forEach(function (f) { if (!only || f.name() === only) folders.push(f); }); });

  if (argv[0] === 'count') {
    let n = 0;
    folders.forEach(function (f) { n += f.notes.id().length; });
    writeLine({ count: n });
    return;
  }

  folders.forEach(function (f, i) {
    const line = { folder: f.name(), index: i, folders: folders.length, ids: [], bodies: [], created: [], modified: [], skipped: 0 };
    const add = function (spec) { // all four fetched before anything is appended, so a failure adds nothing
      const ids = spec.id(), bodies = spec.body(), created = iso(spec.creationDate()), modified = iso(spec.modificationDate());
      line.ids = line.ids.concat(ids);
      line.bodies = line.bodies.concat(bodies);
      line.created = line.created.concat(created);
      line.modified = line.modified.concat(modified);
    };
    try {
      add(f.notes);
    } catch (e) {
      // One unreadable note (locked, or a huge attachment) fails the whole bulk call:
      // retry in slices, and inside a failing slice note by note, skipping the ones that still fail.
      const total = f.notes.id().length;
      for (let s = 0; s < total; s += 25) {
        try { add(f.notes.slice(s, Math.min(s + 25, total))); continue; } catch (e2) {}
        const notes = f.notes();
        for (let k = s; k < Math.min(s + 25, total); k++) {
          try {
            const n = notes[k];
            const body = n.body();
            line.ids.push(n.id()); line.bodies.push(body);
            line.created.push(iso([n.creationDate()])[0]); line.modified.push(iso([n.modificationDate()])[0]);
          } catch (e3) { line.skipped++; }
        }
      }
    }
    writeLine(line);
  });
}
