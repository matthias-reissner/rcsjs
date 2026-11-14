# rcsjs

A dependency-free JavaScript library for reading and writing text-based RCS
archives. It works in Node.js and modern browsers.

## Current scope

The library supports parsing and serializing standard RCS archive files,
creating archives, checking in trunk and branch revisions, and checking out
trunk and branch revisions. Checkout expands common RCS keywords by default;
the keyword mode and source path can be supplied as options.

## Example

```js
import {
  checkin,
  checkout,
  createArchive,
  parseArchive,
  serializeArchive,
} from "@matthias-reissner/rcsjs";

let archive = createArchive({ description: "Example file" });
archive = checkin(archive, "hello\n", {
  author: "alice",
  log: "Initial revision",
});
archive = checkin(archive, "hello, RCS!\n", {
  author: "alice",
  log: "Update greeting",
});

const restored = parseArchive(serializeArchive(archive));
console.log(checkout(restored, "1.1")); // hello
console.log(checkout(restored));        // hello, RCS!

// Create a branch from revision 1.1.
archive = checkin(archive, "branch version\n", {
  author: "alice",
  branch: "1.1.2",
  log: "Start branch",
});
console.log(checkout(archive, "1.1.2")); // branch version

// Supply the archive path for path-based keywords such as $Header$.
console.log(checkout(archive, undefined, { source: "RCS/example.txt,v" }));
```

Run the test suite with `npm test`.

Install the published package with:

```sh
npm install @matthias-reissner/rcsjs
```

For Node.js file access, import the optional adapter. It can read/write archive
files and check working files in or out:

```js
import {
  checkinFile,
  checkoutFile,
  readArchiveFile,
  writeArchiveFile,
} from "@matthias-reissner/rcsjs/node";

await checkinFile("RCS/example.txt,v", "example.txt", {
  author: "alice",
  log: "Update",
});
await checkoutFile("RCS/example.txt,v", "example.txt", "1.1");
```

The `rcsjs` CLI provides basic `ci`, `co`, `rlog`, `rcsdiff`, `rcsmerge`,
symbol, and lock management workflows. When an `RCS` subdirectory exists,
check-in stores archives there and checkout resolves archives there by default;
`co -p` writes the selected revision to standard output.
Check-in keeps the working file, and checkout refuses to overwrite an existing
working file unless `--force` is provided:

```sh
rcsjs ci --author alice --message "Initial revision" example.txt
rcsjs co --revision 1.1 example.txt,v
rcsjs rlog example.txt,v
rcsjs rcsdiff example.txt,v 1.1 1.2
rcsjs rcsmerge example.txt,v 1.1 1.2 1.1.2.1
rcsjs tag example.txt,v release 1.2
rcsjs untag example.txt,v release
rcsjs lock example.txt,v alice 1.2
rcsjs unlock example.txt,v alice 1.2
rcsjs strict example.txt,v on
```

`rcsmerge` writes the merged text to standard output and exits with status 1
when it inserts conflict markers.
`rcsmerge` currently handles text revisions; binary revisions can be checked in
and out, but binary merging is not supported.
An unchanged check-in does not create a revision; use `ci --force` or pass
`{ force: true }` to `checkin` to create one anyway.
Use `rcsjs tag --force` to move a symbol that already exists.
Strict locking requires the check-in author to hold the lock on the revision
being replaced; a successful check-in releases that lock.

Without an `RCS` directory, check-in stores the archive as `example.txt,v`;
checkout removes the `,v` suffix to determine the working-file path.

Node.js archive updates use a temporary file followed by a rename and an
exclusive `.lock` file to prevent concurrent check-ins and metadata changes.
If a process is interrupted, verify no archive update is still running before
removing a leftover lock file. New lock files include their process ID and host.
`rcsjs lock-status example.txt,v` inspects one, and
`rcsjs recover-lock example.txt,v` removes it only when the recorded local
process is no longer running. Legacy or cross-host locks cannot be verified
automatically and must be checked manually.

The Node.js file API also supports binary working files using RCS `-kb` mode.
Pass `binary: true` to `checkinFile` for a new archive; archives with
`expand @b@;` are detected automatically. Use the same option with
`checkoutFile` when reading an archive whose binary mode is not set.
`checkoutFile` returns a `Buffer` in binary mode:

```js
await checkinFile("image.bin,v", "image.bin", {
  author: "alice",
  binary: true,
});
await checkoutFile("image.bin,v", "image-copy.bin", undefined, {
  binary: true,
});
```

Binary mode is also available as `--binary` for the `ci` and `co` commands.
The platform-neutral API supports the same mode with
`createArchive({ binary: true })`; `checkin` accepts a `Uint8Array`,
`checkout` and `serializeArchive` return `Uint8Array`, and `parseArchive`
detects the archive's `expand @b@;` mode.

This package is distributed under the Apache-2.0 license; see [LICENSE](./LICENSE).
