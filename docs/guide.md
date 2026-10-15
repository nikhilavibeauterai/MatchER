# MatchER

Photo tournaments that find your best shots, without staring at all of them.

Point it at a folder. It clears out the junk on its own and stacks bursts and duplicates. You check the
stacks, sort everything into themed groups, then the tournament runs: each stack crowns its best take,
each group plays a mini-tournament, and the best of every group duel it out in the knockouts and a bracket
final. It learns your taste from every call and ranks everything, even the photos you never see.

Two ways to play:

- 🌄 **My best photos**: any folder (trips, landscapes, food, pets, friends). Each kind of photo with
  enough shots gets a cup of its own (Landscape Cup, City Cup, Foodie Cup…), plus a Grand Cup for
  everything.
- 💘 **Photos of me**: profile pics. It finds you in every photo, sets aside the ones you're not in, and
  cares about smiles, open eyes and light. Ends in a blind review package you can send to friends.

Everything runs locally. Nothing is uploaded.

## Run it

```sh
./matcher.sh
```

The [desktop releases](https://github.com/nikhilavibeauterai/MatchER/releases) include the runtime; see
[installation](install.md) for Windows and Linux instructions. The source launcher builds `.venv/` with
hash-checked dependencies. First analysis downloads about 256 MB of model files into the model cache
(or `models/` in a Git checkout), each SHA-256-verified. A browser tab opens through a private link
(`http://127.0.0.1:8765/?k=…`): it sets a cookie and the address bar goes clean; without it the app stays
locked, so other programs and accounts on the machine can't use it.

**Every folder is a save**, like a save slot or a character: its own level, trophies, groups and champions.
*Choose your save* lists them (cover, class, level, stats, when you last played); click one to switch, or
*New save* to pick a class (🌄 Gallery for any photos, 💘 Profile for photos of you) and a folder (desktop
dialog, in-page browser, or paste a path). *Try it with sample photos* opens a bundled, offline set of public-domain
meme faces and classics: Ducreux, the moon from *A Trip to the Moon*, famous paintings and NASA, plus a burst to crown.
The [source manifest](../matcher/demo/manifest.json) records the source, licence and checksum for each image; a copy of
the credits goes with the sample. Model downloads still need the internet on first setup.
Analysis plays out on screen as it happens: photos landing on a light table
with their faces boxed, each photo dropping into its kind, your own face found again and again, bursts folding;
then *Here's what I found* (photos, stacks, set aside and why, kinds, you). The photos float the whole time,
swimming to their kind as it's recognized; *looking closer* shows each head-and-shoulders crop with what it checks
for (sunglasses, a cigarette, a mirror selfie, a filter), and *organizing* plays back the real throw-outs and stacks.
Behind every screen, a sea of colour bleeds out of the photos on it and swirls around your pointer (☰ turns it off).
It starts
immediately (about 5 minutes for ~1,900 photos on this laptop, mostly SigLIP) and resumes if
interrupted. A folder that's already been analyzed opens in seconds. You can switch modes later in
Settings; the photos get re-sorted, and your calls carry over.

Options: `--port 8765`, `--no-browser`, `--data DIR`, and `--lan` (below).

## The journey

Choose your contenders, organize, then play. The photo sea fills the window behind translucent controls.
Eight stage icons sit at the top centre, with the current title below and previous/next arrows alongside.
**Esc / ☰** opens the top-left menu; your save and XP stay top-right. Activities, Picture & sound, and Library
keep the tools together; Escape goes back one menu level before resuming. **?** at the bottom-right toggles
helper text and key hints. It starts on once, then remembers your choice for this save, including after reload.
The hint sits under the stage title and describes the current state (a finish screen says what Enter does next).
The next arrow beside the stage icons is the one way forward: a quiet arrow while a stage is in progress, and the
coral **Next: <stage> →** button in the same place once the stage is ready (Kick off, Start Finals and the finish
screens use it too). **Enter** presses it. **Home** is the open sea. The menu holds cups, trophies, the tournament
board, leaderboard, Rescue, Tag lab, Open arena and its 60-second challenge, plus People in profile mode.

1. 🎛️ **Filter**: play for as long as you want, then press **Enter** to continue to Stacks.
   The D-pad has **← / A / X** Toss on the left, **→ / D** Keep on the right, **↑ / W** Love above,
   **↓ / S** Hate below, and **Space** Skip in the middle. Keep/Toss changes only that take.
   Love keeps that take and teaches the filter to keep its kin; Hate sets it aside and teaches the filter to set
   aside its kin. You can also throw any print across the line in the sea: right of it keeps, left of it tosses. Related changes appear in
   a **preview**. **Z** reverses both parts of a teaching call.
   A newer teaching call can propose revisiting older opposite choices on strongly matching takes. It leaves
   those saved choices intact until you confirm the preview. A later individual Keep/Toss takes priority again;
   moving the threshold alone never reverses it.
   The sea runs from low fit on the left to high fit on the right, with bright photos above dark ones. Drag its
   vertical dividing line: left is out, right is in. The photo and counts respond immediately; thumbnails pass
   freely behind the controls to reach their side. Pointer release returns the arrow keys to play; Tab can focus
   the line for keyboard adjustment. **Z** also undoes a line movement.
   Teaching starts with specific shared subjects or close saved visual embeddings. Contrasting examples can
   distinguish local combinations of light, detail, framing and colour: liking bright dogs and disliking dim dogs
   need not reject every dim photo. For matching copies with no meaningful contrast, your newer lesson revises
   the older one instead of canceling it out. Different photos with ambiguous evidence stay neutral. Independent repeated examples
   can also support broader quality rules. Duplicate takes cannot manufacture confidence.
   **Enter** or the top next arrow saves the preview and continues; it is blocked only while a
   change is processing or no take can proceed. There are no rounds or required review counts.
   **Esc → Browse takes** includes every set-aside take; Keep brings one back. **Explore sea**, **Discard preview**,
   and **Follow rules for this take** live in the same menu. Hover the focused photo for its Copy path control.
2. 🧩 **Stacks**: the same picture (a crop, a copy) or a burst of nearly the same shot belongs in one stack,
   so it competes as one. The obvious ones are stacked already; the **Twin check** minigame shows the pairs
   that look like the same shot but weren't stacked (`→` same shot, `←` different). The Stacks page shows
   every stack as a pile of actual prints, each slightly offset and rotated. Open one to fan out its takes,
   keep a different take, split one out or split it all; drag one onto another to merge, and drag past the top or
   bottom of the list to scroll it. **X** (or the open stack's Set aside button) sets a whole stack aside with
   every take. Similar stacks sit together, with a By date toggle.
3. 👑 **Crown**: each stack's takes duel for the one that plays on: the current best defends against each
   of the others (`←` `→`, `Space` defers the challenger). A half-played Crown resumes after restarting.
   The two takes stay above the sea, with a compact roster and *Left wins* / Skip / *Right wins* controls. Enter
   or the next arrow continues to Groups; it turns coral once every stack is crowned. Crop, enhancement and sound are in **Esc → Picture & sound**;
   `C` and `F` still work while playing. Help toggles the key hints and role labels.
   Changing a stack's takes reopens its Crown, including merging already crowned stacks. The winner becomes
   the stack's cover in Stacks, Groups and the sea, and stays in its current group. Undo restores the earlier pick.
   Large stacks normally compare eight distinct takes; merged stacks keep their former winners in the draw,
   expanding it when more than eight distinct winners need to compete.
   **Esc → Keep best guesses for remaining stacks** finishes the rest in one go.
4. 🗂️ **Groups**: every stack and single shot goes into a themed group (below); once every shot has one, the
   next arrow kicks off the group stage.
5. ⚽ **Group stage**: a mini-tournament inside each group, one group at a time, with its standings under the
   photos (ranked by rating: beating strong photos counts more). The top places of each group go through,
   about twice the leaderboard in all, shared out by group size.
   **Qualify leaders** previews the current advancers and lets you send them through when you've made enough
   comparisons. It records that choice without inventing matches or increasing confidence; Z reopens play.
6. ⚔️ **Knockouts**: the group advancers play elimination rounds, with byes where needed. A loss puts a photo
   out of this bracket; winners advance until eight finalists remain (four in a small cup). The board shows
   every round and lets you choose any pending match. Z puts the eliminated photo and match back. When the
   advancers already fit the bracket (four, or exactly eight) there is nothing to eliminate: the group stage's
   way on says *Next: the finals*, the rail marks Knockouts as skipped, and no stage bonus is paid for it.
7. 🏆 **Finals**: the qualifiers in a bracket: quarterfinals, semifinals, a bronze match, the
   final. Every match also counts as a duel, and the result is final: champion, runner-up and bronze
   become 1, 2 and 3 on the leaderboard and in exports. The champion is crowned on the page itself: the
   stage-clear card, the podium and one way on to the reveal.
8. 🎉 **Reveal**: the podium, your taste card (what you go for, what's not your thing), your run's
   stats, the whole leaderboard, a share card (a picture of your podium and taste, no photo metadata),
   your best shots to keep, and the next cup still waiting for a champion.

Each stage's last screen leads to the next. 🧹 **Clean-up sweep** is a side quest: a short run of
keep-or-toss calls on set-aside photos that score like the middle of the pack, and shots in the running
that are in the bottom few percent *and* visibly flawed.

Your tournament follows your edits: changes to contenders, stacks, chosen takes or groups reopen affected
brackets. Undo restores an earlier bracket only while its contenders still match and no replacement run has
started. Names and ordinary rating changes preserve the run. Earned finalists enter Finals without an early-seeding warning.

In gallery mode each kind of photo with enough shots is a cup (switch on the map); every cup runs the whole
tournament on its own shots, while Filter, the taste model and your calls are shared.

## What it does with your photos

1. **Reads every photo** (JPEG, PNG, HEIC, WebP…; videos are ignored) at preview size, upright and
   colour-corrected, and writes metadata-free previews to `data/<folder>/`.
2. **Finds faces** (YuNet, SFace) and reads blink, smile and head pose (MediaPipe). In *Photos of me*
   the identity that dominates your camera roll is you, your mirror reflections don't count as someone
   else, and **People** shows the matches it's least sure about, with a strict / normal / loose switch.
3. **Understands each photo** with SigLIP: what it shows (people, nature, places, animals, food,
   things), whether it's a screen, receipt or pocket shot, how good it looks, and in *Photos of me*
   things like sunglasses, cigarettes, mirror selfies and filters.
4. **Sets aside obvious throw-outs.** Both modes: screenshots, tiny or unreadable images, hopeless blur
   or exposure. Gallery mode adds documents/receipts/whiteboards and accidental shots (only when the
   photo is also dark or smeared). *Photos of me* adds photos without you and you as a speck. Each one
   keeps its reason and comes back from **Set aside** (or the sweep) in one click. Softer issues only
   lower the starting estimate.
5. **Folds bursts and duplicates** into one *stack* that competes as a single shot: identical files,
   near-identical pixels or looks, a burst within 30 s, or the same capture time with a strong likeness (an
   edited copy or a crop keeps the original's time). A second pass joins whole stacks that belong together
   (a long burst drifting away from its first frame would otherwise split in two), never across a pair you
   said are different shots. You check the possible twins in the Stacks stage (🎮 Twin check).
6. **Groups shots into scenes** (same session, same look) so a leaderboard allows at most 3 per scene.

## The duels

Two photos at a time: *which photo is better?* (or, for profile pics, *which one would make a stranger
want to meet you?*). Gut call, then move on.
When the last winner returns in the next comparison, it stays on the same side and the challenger takes the other.

| Key | |
|---|---|
| `←` `→` (or `A` `D`, or click) | *Left wins* / *Right wins* (top / bottom on a phone) |
| `↑` / `W` | both great (open/group duels) |
| `↓` / `S` | both meh (open/group duels) |
| `Space` | defer without choosing a winner |
| `X` | toss the hovered or keyboard-focused photo; single-photo activities use the current take |
| `Q` / `E` | set aside left / right (recoverable in Filter) |
| `Z` | undo (as many steps back as you like) |
| `C` | auto-crop: best (the crop that uses the most of the window; focus subject when it ties), focus subject, fill height, fill width, off (on every screen with photos, stack tiles and fans included; also in ☰) |
| `F` | Enhance on / off (on every screen with photos; also in ☰) |

- After each pick a chip shows where your pick now sits on the leaderboard (`#7 ▲3`).
- ⚡ **Lightning round**: 60 seconds, as many calls as you can, bonus XP for each; beat your record.
- **Enhance** lays a gentle auto-edit over each photo (levels, a little white balance, midtones,
  a touch of vibrance), worked out on the fly from the photo itself, so a dim or hazy shot that would
  look great after a quick edit can compete fairly. Nothing is written to your files; `F` flips it.
- **Auto-crop** (on by default for profile pics) frames every photo the same way around the face, in a
  4:5 window with the overflow fading inside its own pane. A photo without a face gets its frame around whatever
  stands out in it instead (a dog, a flower, a car, someone seen from behind: the analysis keeps the salient region;
  an older library works them out from its thumbnails in the background the next time it opens), and a landscape or
  a texture, where nothing stands out, frames on its middle. Gallery mode shows whole photos unless you press `C`.
- **Open arena** on the map keep learning beyond the tournament. Each shot's appeal is *your taste × its features + something specific to that
  shot*; the taste starts from a hand-set prior and is re-learned from every call, so **shots you never
  see get re-ranked too**. Half the pairs settle the shots right at the leaderboard cutoff, the other
  half bring in a photo you haven't seen yet. Knockouts use elimination rounds; open duels keep every shot in play.
- The leaderboard is your top 40 (Settings), or a quarter of the shots in a smaller cup. In the current
  600-shot simulation, 450 open duels reached 86% of ideal shortlist value while the meter estimated 84%;
  at 600 calls it was 90% against 87%. `scripts/simulate.py` reproduces the comparison.
- The **Leaderboard** page shows one shot at a time, as big as the screen allows: `←` / `→` (or `A` / `D`) walk
  the ranks and then *On the bubble*, the next ones in line. A square sticky note on each card carries everything
  the sorter knows about it: rank, how sure it is, duels, appeal, takes (click to swap which one stands in), date,
  tags and looks; drag it wherever you like (it remembers). The file name, group and date are handwritten on the
  card's chin. The card holds still, and slides in and out as you walk the ranks.
  Finishing happens on the **sheet** beside the card: **✨ Enhance** (`F`) with knobs for levels, light, contrast,
  colour and warmth on top of the auto look, **✂ Crop** (`C` walks best, focus subject, fill height, fill width, off) and **↻ Turn**
  (`R`). Each is that shot's own choice, shown live in the card's window, undone with `Z` and baked into **Save my
  best**.
- The **toolbelt** (left edge of every screen but the welcome and the saves) is for leaving notes as you work: a
  pen and a marker in four inks draw on any photo's card (the Leaderboard's, a duel pane, the Finals, the reveal,
  a stack tile or a take in its fan, a print on the map once you have zoomed in on it),
  the note tool sticks your own sticky notes on it (type, drag), and the eraser rubs out only the parts of marks
  you pass over; its Size control changes the brush. **Z** undoes a stroke, note edit or whole erase gesture;
  **Shift+Z** redoes it, including during a tournament. Drawing tools own the photo gesture, so drawing never
  also picks a winner or moves a print. In deep zoom, reach for the belt at the left edge to reveal it; a tool
  in use keeps it visible. These stay with the shot, show wherever it appears, and are not written into the export.

## Tags

**Tag lab** is available from the map, Groups and the menu. Everything the analysis recognizes becomes a **tag**, many per photo:
- **What's in it:** its kind and the ~60 themes it stands out for in *this* library, plus features like outdoors, night out, text.
- **Who:** you or the main character, each person who keeps turning up (rename them), group shots, smiling.
- **How it looks:** black & white, dark, blurry, eyes closed, sunglasses, mirror selfie, face filter, the stunning ones.
- **When:** year, season, night-time, and busy days (outings).

*Looking closer* on the analysis screen shows them being found, and the last step lists them. Every discovery
shown there carries into the game with the same photo membership. Your additions, removals and names survive a refresh.
For saves analyzed before discovery history was stored, **Settings → Re-scan for new photos** fills in the missing
Looking closer tags while keeping your corrections.
**Tags** is an editable page with every tag and its photos, including takes, other cups and Set aside. Rename,
change emoji, merge or delete tags there; Z undoes each edit. **Check this tag** is a finite yes/no game:
→ or Enter adds the tag, ← removes it, and Z undoes the last call.

## Groups

Two views of the same thing (🫧 / ▦ in the top strip):

- **🫧 Sea** (the default on a big screen): measured colourfulness gives every photo a stable horizontal home
  (muted left, colourful right), and brightness supplies the vertical home (dark below, light above). These saved
  measurements work for existing libraries without re-reading originals. The swarm eases around those homes,
  flowing around controls and focused photos. Tags add local attraction, with a buffer between prints and
  limited-range repulsion between unlike photos. Tags have equal weight; partial overlap blends the forces. A stack moves as one
  boid using the combined tags of its takes. Sampled tag clustering and the flock's positions produce roaming lassos
  with playful names and their actual tags in the bottom shelf. Outlines follow occupied space, leaving empty holes
  and disconnected parts; tangled suggestions wait until their photos gather. Your saved groups have solid outlines.
  Assigning a group gives nearby members an extra pull toward one another, while keeping the space between prints.
  Their bubble follows the gathering. Colour gives a neighbourhood, not proof of the same shot: stacks still use
  image similarity and time evidence. New analysis also measures circular hue; the current map remains two-dimensional.
  **Click tags** to gather matching photos onto steady anchors with the duel wobble: **All selected tags** narrows
  the focus, **Any selected tags** widens it, and **Release focus** sends them back. Click a named group in the side
  roster to focus its members; with photos selected, the same click moves them into that group. Each row's separate
  **Focus** button looks without moving the selection. Group keys focus when nothing is selected, and **Esc** releases
  focus. **Drag a photo** to play with the swarm; releasing it keeps its tags and group intact. Explicit selection
  actions, group keys and side-list bins edit groups and stacks. Right-click a label to edit it; **Edit tags** opens
  the full editor. All recognized tags remain in the tag shelf; 🏷️ searches them and **T** tags the selection.
- **▦ List**: every group as a section of tiles (open a stack with ⧉ to keep a take, split one out or split it all).
  Selected photos keep a gold frame and ✓ until you deselect or move them. Click, **Enter** or **Space** toggles a
  photo; **Esc** clears the selection. A white dashed inset marks keyboard focus separately.

In both, click photos to select several, then press the group's key: **1–9**, **0** for the 10th, **Alt+1…Alt+0** for
the 11th to the 20th (Alt+Shift for the 21st to the 30th). **N** makes a new group from the selection, **S** stacks
it, **U** unsorts it, **Z** undoes. The groups are in your order, which sets their keys: drag them in a side list,
**Shift+↑ ↓** on the highlighted one, the island menu's earlier / later, or ▲▼ in the list view. A group left with
no shots disappears (Z brings it back). New groups get a catchy name from what sets their photos apart in this
library (*Golden Hour Gang*, *Good Boy Gallery*, *Office Hours*); 🔎 words (*laptops, screens, desks*), or a name
you typed yourself, steer which photos come up first.

Two minigames speed it up. **🎮 Quick sort** deals the unsorted shots one at a time beside the list of groups:
**↑ ↓** walk the list (it starts on the ★ group the photo looks most like), **→ or Enter** puts it there, a key or a
drag puts it elsewhere, **N** starts a new group, **←** tosses a throw-out (to Set aside, as tossed), **E** renames the
highlighted group (or ✏️), its emoji changes it.
**Esc** opens the menu to resume or return to Groups. **🎮 Find more** (on each group) deals the unsorted shots likeliest to belong to that group: **→** in,
**←** to pick another group with **↑ ↓**. **✨ Auto-group the rest** does it for you.

## The sea

The sea is calm and explorable. Prints settle where their colour (left muted, right colourful) and brightness
(low dark, high bright) put them, nudged locally by shared tags and spacing, and then stay put. Every photo in
MatchER is the same polaroid: a 3:4 paper card with the picture contained in its window, so a landscape and a
portrait compare as equals, and a stack is a pile of those cards with its count on the chin. Drag open water to pan, use the wheel or a
pinch to zoom in on a neighbourhood, and double-click open water (or a print you have zoomed right into) to see
everything again. A print you pick up floats over the others; when you let go, its neighbours make a little room
and nothing farther away moves. On the map or the Groups sea, drop one print onto another to stack all their
takes: the target lights up green and says **Drop to stack**. **Z** undoes it. Drop inside a group's lasso to file
the shot there, or onto open water to move it without stacking. The small prints are drawn by your graphics card (every one of them a real
thumbnail at any size), so a sea of thousands pans and zooms without the CPU breaking a sweat and holds still at
rest; a print only gets a card of its own once it is big enough on screen to need one.

**Developer mode** (`./matcher.sh --debug`, or add `?debug=1` to the address once; `?debug=0` forgets it) keeps a
panel on every screen with the sea's knobs: the macro order (rank spread, margins, jitter, home pull), the micro
order (wander, reach, contact buffer, repulsion, tag affinity, group cohesion, damping, force limits, settling),
the renderer, the camera and the wobble (period, force, and how much each card's delay, speed and force may
differ). Changes apply live and stay in that browser until Reset; **Export** copies the
session as JSON to the clipboard and downloads it, and **Import** applies one. `F2` collapses the panel.

Every screen sits in the same sea of photos: every photo, including takes, other cups and Set aside, floating with its tags (photos that share tags
drift together), groups held in lasso bubbles, stacks drawn as piles, the top of the leaderboard wearing their rank.
The swarm and clustering run in a worker. At large sizes, cached thumbnail sheets replace individual image nodes;
the smallest photos update less often but keep their own positions and tag forces. The performance target is a
10,000-photo library. Working photos gain detail, and the sea leaves padding around the controls.
The sea flows around each screen's own things and through its margins; moving to another screen rearranges the same
photos rather than swapping them out. Photos and groups make room for neighbours and the screen's controls;
the thumbnails stay to the sides while the players take the centre. Large libraries load progressively:
a device-sized set of moving thumbnails sits among small real previews of the rest, which can still be selected.
Every recognized tag has a control in a steady bottom row above the action bar, on desktop and phone. Click to
focus matching shots; right-click to select its photos, edit its name or emoji, inspect its roster, or check it in
the tag minigame.

- **Grab any photo** from the sea, on any screen (on the map a click zooms in until the card fills four fifths of
  the height, so there a double-click grabs it): it comes up to the middle, bigger, with its group, rank, stack and
  tags, and what you can do with it: edit tags, move to a group, stack with another photo, fan its takes out,
  keep or split a take, toss or rescue. Shift-click selects several to work on together. Esc shrinks them back to their spots.
- **Copy path** copies a take's full original file path from the photo viewer, sea inspection, open stack or Filter
  review. Right-click a photo to open its viewer, including during a duel. If clipboard access is blocked, the path
  appears selected for manual copying. A stack take copies its own path, even when another take is its cover.
- The photos a screen brings to you (a duel's pair, the sweep's card, Twin check's pair, Quick sort's card, the finals)
  lift out of their spot in the sea, grow into place and wobble gently; when you're done they sink back, a winner
  glowing gold on the way.
- **The analysis screen** is the same sea: every photo joins it as it's read and stays, and each tag it finds (faces,
  smiles, its kind, the themes it stands out for, what *Looking closer* sees) pulls the photos that share it together,
  with lassos following the flocks as they settle. A short live status reports the work; the current photo grows
  into focus with its findings, then rejoins the swarm.
- The photo under the pointer grows a little; one you're holding grows a little more.
- 🏟️ (top bar) is the **tournament board**: each group's roster and standings, the elimination rounds, and the finals.
  The group stage starts with the draw ceremony; group and knockout links jump to the chosen contest.

## The game

- **XP and 15 levels** (photo-themed names in gallery mode, *Snapshot Rookie* to *Legend of the
  Gallery*). Quick calls (under 2.5 s), group-stage and finals matches, crowned stacks, grouping calls and the
  first 30 calls of a lightning round earn extra.
- **Duel stories**: after a pick you see where it landed (`#7 ▲3`), with *Upset!* when an underdog wins and
  *Rematch* for a pair you've judged before. Photos that keep coming up sit a few duels out.
- **Streaks**: quick calls in a row (🔥 in the duel bar), and days in a row on the home screen, with a
  daily goal of 30 calls.
- **Achievements**, from *First impression* to *Thunderstruck* (40 calls in one lightning round),
  *Cartographer* (10 groups) and *Trophy shelf* (champions in 3 cups), plus Cinderella, Wire to wire,
  Flawless take, Giant-killer and Comeback kid. The trophy case is in ☰, grouped by stage.
- XP comes from your vote history (undo takes it back, and calls from before the game existed count);
  achievements, once earned, stay earned. Level-ups mid-duel celebrate on the level chip instead of
  covering the photos.
- Filter awards the same 2 XP for reviewing a different shot whether you keep it or set it aside, up to the
  first 24 shots. Reviewing twelve earns *Finding your standards*. Repeated calls on a stack cannot farm points.
  Calling every take earns *Every take considered*, without ending play or counting skips as decisions.
- **Stage clear**: every stage ends on the same card (the stamp, the stage's icon, one line, the bonus and what came
  through) with the sea calmed behind it: Filter on its way to Stacks, Twin check, Quick sort, Crown, the group stage,
  the knockouts and the champion. Streak milestones at 5, 10, 15, 25 and 50 quick calls; *Deciders* in the group stage say when
  a duel can send a photo through; a team keeps one colour from its lasso to its standings card, its chip and its duel
  frame; the finals call out who advances (and upsets); Quick sort scores how often its ★ guess was right and counts combos.
  The leaderboard's confidence lives in the pause menu; standings show odds only once a group has played a match, and
  the map's rank badges appear once there are calls behind them.
- **One HUD everywhere**: stage icons and title above the play area (done stages wear a check, a skipped one a dash),
  the next arrow that fills coral with the next stage's name when you can proceed, the state's hint under the title,
  menu top-left, save with level and XP top-right, Help bottom-right.
  **Enter** proceeds, **Esc** pauses, **Z** undoes and **Shift+Z** redoes. Undo/Redo briefly show the affected
  thumbnails and next reversible changes, then disappear. Every stage's finish points to the next stage. Duels share
  Filter's cross: ↑ *Both great* above Skip, ↓ *Both meh* below, with Undo, Crop and Enhance beside it.
- **Pause and resume**: Esc first dismisses an open dialog, inspection or selection; otherwise it opens the menu.
  Resume keeps the current round and keyboard focus. Leave returns to the activity's editor or the map. The
  Lightning clock pauses with the menu; background photo analysis continues.
- Synthesized sounds (🔊 in the duel bar or ☰ mutes them), confetti, the champion's podium, and duel photos that
  wobble until you hover one. Your system's *reduce motion* setting disables wobble, photo flights, confetti and animated colour effects;
  the functional photo swarm still settles and roams.
  Without WebGL (the developer panel's *Sprites on the GPU* knob off), the 2D canvas takes over and past a few
  thousand photos the smallest prints draw as paper dots in each photo's own colour (*Dot prints under*).
  The wheel zooms far enough to read one print's details; a print always loads the smallest halving of its preview
  (50 to 1600 px) that still has a pixel for every screen pixel at its size, both ways as you zoom, and once a
  print fills four fifths of the screen's height it shows the original file. The developer panel's *Max zoom* knob
  sets how far.

## Keeping your best

From the **Reveal** or the **Leaderboard**:

- Camera raw files are photos too: `.nef`, `.dng`, `.raw`, `.arw`, `.cr2`, `.cr3`, `.orf`, `.rw2`, `.raf` and
  `.pef` are read through LibRaw (camera white balance, the camera's orientation) and dated from their EXIF.
- **Save my best** copies your top shots as the original files (metadata and all) into
  `data/<folder>/exports/best-<cup>-<time>/`, named by rank: `01 - IMG_1234.jpg` is your best. The card that
  confirms it leads on to the next cup (or the share card), with *Open folder* beside the path.
  `touched up/` inside that folder holds the same shots the way the Leaderboard shows them: enhanced (auto levels, a
  mid-tone lift and a little colour) unless you switched that off, cropped to the subject or turned where you chose,
  at full size with EXIF kept. What you saw is what you keep.
- **Blind review package** (`exports/export-<time>/`) is for asking other people:

| File | |
|---|---|
| `share/review_photos.zip` | send this: `P001.jpg…` in shuffled order, 2048 px, no metadata of any kind |
| `share/photos/` | the same files loose |
| `KEY.PRIVATE.csv` | keep it (outside `share/`): maps P-numbers to your originals, ranks and confidence |

Every exported JPEG is checked segment by segment (only the image tables survive), and the zip carries no
timestamps. Metadata is stripped; pixels aren't. Look through it once for anything in frame you
wouldn't want a stranger to see.

## Play from your phone

```sh
./matcher.sh --lan
```

It also listens on your home network and prints a link like `http://192.168.x.x:8765/?k=…`. That link
is the key (it sets a cookie, then the address bar is clean); without it every request is refused. Your
firewall may need to allow the port. The sweep takes swipes.

## Privacy and safety

- Your originals are only ever read. Previews, the database (including face data) and exports live under
  `data/`, readable by your account only. **Settings → Forget this library** deletes all of it for a
  folder; your photos stay.
- The server binds to `127.0.0.1` unless you pass `--lan`, and only answers with the private link's
  cookie (the key lives in `data/secret`; delete it to change the link). It refuses unexpected `Host`
  headers and cross-site requests, every state-changing request needs a custom header other sites can't
  send, and the page runs under a strict Content-Security-Policy.
- Oversized images (pixel bombs, files over 300 MB) are refused before decoding, and pointing it at a
  folder with more than 200,000 photos (say, `/`) is refused up front.
- Dependencies are hash-pinned (`requirements.lock`), model files are pinned by SHA-256, and the page
  loads nothing from the internet. The only network request the app makes on its own is the model
  download on first run. The bundled sample works offline; the larger public-domain browser-test fixture is
  fetched only by the test setup script.

## Files

```
matcher.sh            launcher (venv + deps on first run)
matcher/              the app: analyze.py (pipeline), library.py (identity, categories, throw-outs,
                      stacks, scenes, priors), ranker.py (tournament model), server.py (web API: duels,
                      minis, sweep, finals, undo, saves), draw.py (groups, the group stage, knockouts),
                      themes.py (theme names, matching, auto-grouping), game.py (XP, levels,
                      achievements), export.py, sample.py (the sample library), static/ (UI; emoji.json
                      is the emoji picker's index)
requirements.lock     every dependency at an exact version with SHA-256 hashes (what the launcher installs)
models/               model files (git-ignore this)
data/                 one folder per photo library: matcher.db, previews, thumbs, exports
scripts/simulate.py   duels-needed simulation against a known ground truth
scripts/make_emoji.py rebuilds static/emoji.json from Unicode names plus everyday words
tests/                pytest suite (no models or real photos needed)
```

Tests: `.venv/bin/python -m pip install pytest && .venv/bin/python -m pytest tests -q` (105 tests, ~45 s).
