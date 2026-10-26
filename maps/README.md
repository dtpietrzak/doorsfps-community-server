# Maps

Two pools. Map files do not sit in this folder itself.

- `competitive/` — ranked and community arenas. Easy, medium, hard, and ranked servers link here.
- `raid/` — Maze waves (`Raid02-00` … `Raid02-06`). The raid server also loads `competitive/` because Breezeway and Midway play those arenas.

Campaign (single-player) maps ship with the game client. The match server never loads them.

A downloadable community server still ships a flat `maps/*.doors.json` folder: competitive and raid. Drop a custom arena in that flat folder.
