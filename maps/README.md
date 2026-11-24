# Maps

Map files do not sit in this folder itself.

- `competitive/` — ranked and community arenas. Easy, medium, hard, and ranked servers link here.

- `raid/` — raid maps. Raid servers link the maps root, which the loader reads as `competitive/` + `raid/` only.
- `zombots/` — Zombots maps (`mirrorMode: "zombots"`, at least one `zombieSpawns` entry). A Zombots server links this folder alone. Arena and raid servers never load it. These maps ship in the public mirror.

Campaign (single-player) maps ship with the game client. The match server never loads them.

A downloadable community server ships a flat `maps/*.doors.json` folder. Drop a custom arena in that flat folder. Zombots maps can sit there too: the loader filters by `mirrorMode`, so an arena server skips them and a Zombots server takes only them.
