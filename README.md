# TableBot Web

Control the Joola Infinity table tennis robot from an iPhone, or any phone or computer whose
browser supports Web Bluetooth. It's a static web page, so there's no build step, no server code
and no accounts.

It's a port of the Android app in `../table_tennis_robot_app`. The protocol code
(`js/protocol.js`) follows `RobotProtocol.kt` line for line, and `../table_tennis_robot_app/PROTOCOL.md`
documents every byte.

## Using it on an iPhone

Safari (and every other iOS browser, since they all use Safari's engine) does **not** support Web
Bluetooth. Use **Bluefy – Web BLE Browser**, a free App Store app:

1. Install Bluefy.
2. Open the GitHub Pages URL in Bluefy.
3. Tap **Connect**, then pick the robot (`J-…`) from the list.
4. Pick a drill, choose how long to play, and tap **Play**. **STOP** stays at the bottom of the
   screen while a drill runs.

Close other apps that grab Bluetooth devices first, especially Life360. The robot accepts only
one connection at a time, and Life360 has been seen connecting to it mid-session.

Keep the screen on. If the phone locks, iOS suspends the page and the link drops. The page
requests a screen wake lock, but that may not work in every browser.

## What's included

- The 69 bundled drills (36 basic, 33 advanced), with search and a Basic/Advanced filter.
- Play for a number of repetitions, a number of balls, or a length of time.
- A custom drill builder: ball type, spin, power, and Single/Sequence/Random mode on the 3×5 grid.
  Positions that the motor table doesn't support are greyed out. **Test one ball** fires a single
  shot.
- A STOP button that sends `0x03`, the only command that stops a drill while it's firing.
- Settings for the idle stop command (V1/V2), the write chunk size and the delay before service
  discovery. The defaults match the Android app.
- A connection log with a Copy button, for debugging at the table.

**Not included yet:** saving your own drills, the drill editors, calibration, and training history.

### How connecting differs from the Android app

- Web Bluetooth never reveals the robot's MAC address. The device ID comes from the advertised
  name (`J-XXXXXXXXXXXXXXXX`), which is also what the Android app uses first.
- If the robot doesn't answer the version query after 3 retries, the page stays connected in an
  **unverified** state (amber dot) rather than disconnecting, so you can still try a drill. The
  robot has been seen answering only some of the time while still accepting writes.
- Connection parameters can't be tuned from a browser.

## Publishing on GitHub Pages

This folder is the whole site. Everything uses relative paths, so it works from a project page
like `https://<user>.github.io/<repo>/`.

```sh
cd tablebot-web
git add -A
git commit -m "TableBot Web"
git branch -M main
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

Then open the repo's **Settings → Pages**, set **Source: Deploy from a branch** and
**Branch: `main` / `(root)`**, and save. The site appears a minute or so later. GitHub Pages
serves it over HTTPS, which Web Bluetooth requires.

`.nojekyll` is there so GitHub serves the files as they are, without running Jekyll.

## Does it need internet?

- **To open the page the first time:** yes.
- **At the robot:** the page talks to the robot over Bluetooth only. `sw.js` caches the app
  shell so it can reopen with no signal. Service workers aren't guaranteed in third-party iOS
  browsers like Bluefy, so before relying on it, load the page once, turn on airplane mode (with
  Bluetooth back on) and check that it still opens.

When you change `index.html`, the CSS, the JS or the data files, bump `CACHE` in `sw.js`. Changes
show up on the second launch after a push: the first launch refreshes the cache in the background.

## Developing

To serve it locally:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

Web Bluetooth only runs on HTTPS or `localhost`. Desktop Chrome and Edge support it, but Chrome on
Linux may need `chrome://flags/#enable-experimental-web-platform-features`.

To run the protocol tests (headless Chrome; nothing is installed):

```sh
test/run.sh
```

The tests check the connect frame against bytes captured from a real robot, the pattern layouts
against the worked examples in `PROTOCOL.md`, frame reassembly, play-mode arithmetic, and the
bundled data. You can also open `test/index.html` in a browser through the local server.

## Files

| Path | What |
|---|---|
| `index.html`, `css/style.css` | The page |
| `js/protocol.js` | Frames, CRC, pattern encoding, response parsing, play modes. No Bluetooth or DOM code |
| `js/robot.js` | Web Bluetooth connection, write queue, play/stop/keepalive sequence |
| `js/app.js` | UI |
| `data/*.json` | Motor table and bundled drills, copied from the Android app's `assets/` |
| `sw.js` | Offline cache |
| `test/` | Protocol tests |
