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

The first run builds `.venv/` (~700 MB of dependencies, installed from `requirements.lock`: exact versions,
every file checked against its published SHA-256) and, if they're missing, downloads the four models into
`models/` (~245 MB, each SHA-256-verified). A browser tab opens through a private link
(`http://127.0.0.1:8765/?k=…`): it sets a cookie and the address bar goes clean; without it the app stays
locked, so other programs and accounts on the machine can't use it.

**Every folder is a save**, like a save slot or a character: its own level, trophies, groups and champions.
*Choose your save* lists them (cover, class, level, stats, when you last played); click one to switch, or
*New save* to pick a class (🌄 Gallery for any photos, 💘 Profile for photos of you) and a folder (desktop
dialog, in-page browser, or paste a path). *Try it with sample photos* downloads ~45 public-domain pictures
from Wikimedia Commons to play with. Analysis plays out on screen as it happens: photos landing on a light table
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

Organize first, then play. Every screen is laid out like a game's: it fills the window, the thing you're
playing is as big as it can be, the panels you need dock to the edge, the action bar sits at the bottom with
the way forward on the right, and the explanations live behind **?** instead of in paragraphs. The top bar is
the HUD: your save (avatar, level, XP), the journey track
(done stages get a ✓, the next one glows, click any of them) and ☰ for everything else (Leaderboard, Set
aside, People, Trophies, Switch save, Settings, sound). **Home** is the map: the seven stages as a path across
the screen, your current top shots, the one thing to do next, and you (level, streak, trophies, cups, the side
quest) on the right.

1. 🧩 **Stacks**: the same picture (a crop, a copy) or a burst of nearly the same shot belongs in one stack,
   so it competes as one. The obvious ones are stacked already; the **Twin check** minigame shows the pairs
   that look like the same shot but weren't stacked (`→` same shot, `←` different). The Stacks page shows
   every stack: open one to keep a different take, split one out or split it all; drag one onto another to
   merge.
2. 🗂️ **Groups**: every stack and single shot goes into a themed group (below).
3. 👑 **Crown**: each stack's takes duel for the one that plays on: the current best defends against each
   of the others (`←` `→`, `Space` = can't tell). *Keep the best guess for the rest* finishes it in one go.
4. ⚽ **Group stage**: a mini-tournament inside each group, one group at a time, with its standings under the
   photos (ranked by rating: beating strong photos counts more). The top places of each group go through,
   about twice the leaderboard in all, shared out by group size.
5. ⚔️ **Knockouts**: the group winners (plus any strong runner-up) duel it out (below). The meter shows
   how close your top N is to the best it could be; once it's settled, the finals are next.
6. 🏆 **Finals**: the leaderboard's top 8 in a bracket: quarterfinals, semifinals, a bronze match, the
   final. Every match also counts as a duel, and the result is final: champion, runner-up and bronze
   become 1, 2 and 3 on the leaderboard and in exports.
7. 🎉 **Reveal**: the podium, your taste card (what you go for, what's not your thing), your run's
   stats, the whole leaderboard, a share card (a picture of your podium and taste, no photo metadata),
   your best shots to keep, and the next cup still waiting for a champion.

Each stage's last screen leads to the next. 🧹 **Clean-up sweep** is a side quest: a short run of
keep-or-toss calls on set-aside photos that score like the middle of the pack, and shots in the running
that are in the bottom few percent *and* visibly flawed.

In gallery mode each kind of photo with enough shots is a cup (switch on the map); every cup runs the whole
journey on its own shots, while the taste model and your calls are shared.

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

| Key | |
|---|---|
| `←` `→` (or `A` `D`, or click) | pick left / right |
| `↑` | both great |
| `↓` | both meh |
| `Space` | skip (can't tell) |
| `Q` / `E` | toss left / right for good |
| `Z` | undo (as many steps back as you like) |
| `C` | auto-crop on / off (on every screen with photos; also in ☰) |
| `F` | auto-filter on / off (on every screen with photos; also in ☰) |

- After each pick a chip shows where your pick now sits on the leaderboard (`#7 ▲3`).
- ⚡ **Lightning round**: 60 seconds, as many calls as you can, bonus XP for each; beat your record.
- **Auto-filter** lays a gentle auto-edit over each photo (levels, a little white balance, midtones,
  a touch of vibrance), worked out on the fly from the photo itself, so a dim or hazy shot that would
  look great after a quick edit can compete fairly. Nothing is written to your files; `F` flips it.
- **Auto-crop** (on by default for profile pics) frames every photo the same way around the face, in a
  4:5 window with the overflow fading out. Gallery mode shows whole photos unless you press `C`.
- There's no elimination. Each shot's appeal is *your taste × its features + something specific to that
  shot*; the taste starts from a hand-set prior and is re-learned from every call, so **shots you never
  see get re-ranked too**. Half the pairs settle the shots right at the leaderboard cutoff, the other
  half bring in a photo you haven't seen yet.
- The leaderboard is your top 40 (Settings), or a quarter of the shots in a smaller cup. In simulation
  on a 645-shot library the meter tracked the true value within a couple of points: ~300 duels reached
  about 88%, ~450 about 92%. `scripts/simulate.py` reproduces this.

## Tags

Everything the analysis recognizes becomes a **tag**, many per photo:
- **What's in it:** its kind and the ~60 themes it stands out for in *this* library, plus features like outdoors, night out, text.
- **Who:** you or the main character, each person who keeps turning up (rename them), group shots, smiling.
- **How it looks:** black & white, dark, blurry, eyes closed, sunglasses, mirror selfie, face filter, the stunning ones.
- **When:** year, season, night-time, and busy days (outings).

*Looking closer* on the analysis screen shows them being found, and the last step lists them. Automatic tags are
worked out again on every refresh; the ones you add or take away, and names you give tags, are kept.

## Groups

Two views of the same thing (🫧 / ▦ in the top strip):

- **🫧 Tags** (the default on a big screen): every photo floats in a sea of fuzzy Venn diagrams. Photos keep a little
  apart and never pile up; every tag pulls its photos together, its circle drawn around them and tightening as they
  gather, and a photo keeps out of circles it doesn't belong to. Stacks look like piles of prints. The shots not in a
  group yet are **k-means-clustered on their tags** into suggested groups (dashed lasso bubbles; *Make* one, or *Lock in
  all*); your groups are solid bubbles with their number on each photo. **Drag a photo** among the circles: it takes the
  tags of the circles you drop it in and loses the ones it left (the hint by the pointer says exactly which). Drop it on
  a group's label (or its bin in the side list) to put it in that group, or onto another photo to stack them. Click a
  circle's label to rename the tag, change its emoji, select its photos or hide it; 🏷️ lists every tag and picks which
  ones are circles. **T** tags the selection with a tag of your own.
- **▦ List**: every group as a section of tiles (open a stack with ⧉ to keep a take, split one out or split it all).

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
highlighted group (or ✏️), its emoji changes it,
**Esc** leaves. **🎮 Find more** (on each group) deals the unsorted shots likeliest to belong to that group: **→** in,
**←** to pick another group with **↑ ↓**. **✨ Auto-group the rest** does it for you.

## The sea

Every screen sits in the same sea of photos: every shot of the cup, floating with its tags (photos that share tags
drift together), groups held in lasso bubbles, stacks drawn as piles, the top of the leaderboard wearing their rank.
The sea flows around each screen's own things and through its margins; moving to another screen rearranges the same
photos rather than swapping them out.

- **Grab any photo** from the sea, on any screen: it comes up to the middle, bigger, with its group, rank, stack and
  tags, and what you can do with it (full size, Groups, toss); Esc shrinks it back to its spot.
- The photos a screen brings to you (a duel's pair, the sweep's card, Twin check's pair, Quick sort's card, the finals)
  lift out of their spot in the sea, grow into place and wobble gently; when you're done they sink back, a winner
  glowing gold on the way.
- **The analysis screen** is the same sea: every photo joins it as it's read and stays, and each tag it finds (faces,
  smiles, its kind, the themes it stands out for, what *Looking closer* sees) pulls the photos that share it together,
  the biggest tags drawn as fuzzy circles. The photo being worked on is grabbed out of the sea with what's being found
  shown right on it, then goes back among its kind.
- The photo under the pointer grows a little; one you're holding grows a little more.
- 🏟️ (top bar) is the **tournament board**: every group's roster and standings with the cut, the race for the finals'
  eight seats (and the next four, on the bubble) with each photo's team, and the bracket.

## The game

- **XP and 15 levels** (photo-themed names in gallery mode, *Snapshot Rookie* to *Legend of the
  Gallery*). Quick calls (under 2.5 s), group-stage and finals matches, crowned stacks, grouping calls and the
  first 30 calls of a lightning round earn extra.
- **Duel stories**: after a pick you see where it landed (`#7 ▲3`), with *Upset!* when an underdog wins and
  *Rematch* for a pair you've judged before. Photos that keep coming up sit a few duels out.
- **Streaks**: quick calls in a row (🔥 in the duel bar), and days in a row on the home screen, with a
  daily goal of 30 calls.
- **33 achievements**, from *First impression* to *Thunderstruck* (40 calls in one lightning round),
  *Cartographer* (10 groups) and *Trophy shelf* (champions in 3 cups). The trophy case is in ☰.
- XP comes from your vote history (undo takes it back, and calls from before the game existed count);
  achievements, once earned, stay earned. Level-ups mid-duel celebrate on the level chip instead of
  covering the photos.
- **Stage clear**: finishing a stage stamps it and pays out (every shot grouped, each group decided, the group stage
  done, each champion). Streak milestones at 5, 10, 15, 25 and 50 quick calls; *Deciders* in the group stage say when
  a duel can send a photo through; in the knockouts and the finals each photo wears its group's colours; the finals
  call out who advances (and upsets); Quick sort scores how often its ★ guess was right and counts combos.
- **One layout everywhere**: a strip on top (what this is, its numbers, **?** for how it works), the one thing to look
  at in the middle, a side rail where it helps, and the action bar at the bottom with the way forward always on the
  right. **Enter** takes it (it's the same as **→** in the minigames), **Esc** leaves a minigame, **Z** undoes. Every
  stage's finish points to the next stage.
- Synthesized sounds (🔊 in the duel bar or ☰ mutes them), confetti, a podium ceremony, and duel photos that
  wobble until you hover one. Your system's *reduce motion* setting stills all of it.

## Keeping your best

From the **Reveal** or the **Leaderboard**:

- **Save my best** copies your top shots as the original files (metadata and all) into
  `data/<folder>/exports/best-<cup>-<time>/`, named by rank: `01 - IMG_1234.jpg` is your best.
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
  download on first run; the sample photos download only when you ask for them.

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
