(() => {
  'use strict';

  const TILE = 24;
  const COLS = 19;
  const ROWS = 22;
  const W = COLS * TILE;
  const H = ROWS * TILE;

  // Maze legend:
  //   # wall   . pellet   o super gem (corner)
  //   - goblin gate (only goblins pass)
  //   space = open path with no pellet
  const MAZE_TEMPLATE = [
    '###################',
    '#o.......#.......o#',
    '#.##.###.#.###.##.#',
    '#.................#',
    '#.##.#.#####.#.##.#',
    '#....#...#...#....#',
    '####.### # ###.####',
    '####.#       #.####',
    '####.# ##-## #.####',
    '    .  #   #  .    ',
    '####.# ##### #.####',
    '####.#       #.####',
    '####.# ##### #.####',
    '#........#........#',
    '#.##.###.#.###.##.#',
    '#.................#',
    '#.#.#.#####.#.#.#.#',
    '#...#...#.#...#...#',
    '#.#######.#######.#',
    '#o...............o#',
    '###################',
    '                   ',
  ];

  // Spawn / structural points (col, row)
  const PLAYER_SPAWN = { col: 9, row: 15 };
  const GOBLIN_PEN = { col: 9, row: 9 };
  const GATE = { col: 9, row: 8 };
  const TUNNEL_ROW = 9;
  const BONUS_SPOT = { col: 9, row: 11 };

  const DIRS = {
    UP:    { x: 0, y: -1 },
    DOWN:  { x: 0, y: 1 },
    LEFT:  { x: -1, y: 0 },
    RIGHT: { x: 1, y: 0 },
  };
  const ALL_DIRS = [DIRS.UP, DIRS.DOWN, DIRS.LEFT, DIRS.RIGHT];

  const COLORS = {
    wall:       '#1133aa',
    wallEdge:   '#5577ff',
    pellet:     '#ffd54a',
    superGem:   '#ff8eea',
    cowgill:    '#ffd54a',
    cowgillSkin:'#ffe0a0',
    hat:        '#7a3a12',
    bandana:    '#cc2222',
    gobBody:    ['#e63946', '#ff85c1', '#56cfe1', '#ff9f1c'],
    gobScared:  '#3344ff',
    gobScaredEnd:'#ffffff',
    eyes:       '#ffffff',
    pupils:     '#000022',
    bonus:      '#ffeb3b',
  };

  const SCORES = {
    pellet: 10,
    superGem: 50,
    goblin: [200, 400, 800, 1600],
    bonus: [500, 800, 1200, 2000],
    extraLife: 10000,
  };

  const POWER_DURATION_BY_LEVEL = (lvl) => Math.max(2.5, 8 - (lvl - 1) * 0.6);

  const canvas = document.getElementById('game');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const overlay = document.getElementById('overlay');
  const $score = document.getElementById('score');
  const $hi = document.getElementById('highscore');
  const $level = document.getElementById('level');
  const $lives = document.getElementById('lives');

  // ---------- Game state ----------
  let grid;          // 2D char array (mutable; pellets removed as eaten)
  let pelletsLeft;
  let player;
  let goblins;
  let bonus;         // { col, row, kind, expires }
  let score;
  let hiScore = parseInt(localStorage.getItem('cowgillHi') || '0', 10);
  let level;
  let lives;
  let powerTimer;    // seconds remaining in power mode
  let goblinChain;   // # goblins eaten this power-up
  let mode;          // 'title' | 'ready' | 'play' | 'dying' | 'levelup' | 'gameover'
  let modeTimer;
  let bonusSpawned;  // count this level (max 2)
  let extraLifeAwarded;
  let frame = 0;
  let paused = false;

  function tileAt(col, row) {
    if (row < 0 || row >= MAZE_TEMPLATE.length) return '#';
    if (col < 0 || col >= COLS) return ' ';
    return grid[row][col];
  }
  function setTile(col, row, ch) {
    const r = grid[row];
    grid[row] = r.substring(0, col) + ch + r.substring(col + 1);
  }
  function blocked(col, row, who) {
    const t = tileAt(col, row);
    if (t === '#') return true;
    if (t === '-') {
      // gate: goblins always allowed; eaten goblins must pass to re-enter; player blocked
      return who === 'player';
    }
    return false;
  }

  function resetMaze() {
    grid = MAZE_TEMPLATE.slice();
    pelletsLeft = 0;
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = grid[r][c];
        if (t === '.' || t === 'o') pelletsLeft++;
      }
    }
  }

  function tileCenter(col, row) {
    return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
  }

  function entityCol(e) { return Math.floor(e.x / TILE); }
  function entityRow(e) { return Math.floor(e.y / TILE); }

  function isCenteredOnTile(e, tol = 1.5) {
    const cx = entityCol(e) * TILE + TILE / 2;
    const cy = entityRow(e) * TILE + TILE / 2;
    return Math.abs(e.x - cx) <= tol && Math.abs(e.y - cy) <= tol;
  }

  function snapToTile(e) {
    e.x = entityCol(e) * TILE + TILE / 2;
    e.y = entityRow(e) * TILE + TILE / 2;
  }

  function newPlayer() {
    const c = tileCenter(PLAYER_SPAWN.col, PLAYER_SPAWN.row);
    return {
      x: c.x, y: c.y,
      dir: { x: 0, y: 0 },
      next: { x: 0, y: 0 },
      speed: 1.6,
      mouth: 0,
      alive: true,
      facing: 'left',
    };
  }

  function newGoblin(idx) {
    const slots = [
      { col: 8, row: 9 },
      { col: 9, row: 9 },
      { col: 10, row: 9 },
      { col: 9, row: 7 }, // 4th hovers above gate
    ];
    const s = slots[idx];
    const c = tileCenter(s.col, s.row);
    return {
      x: c.x, y: c.y,
      home: s,
      dir: { ...DIRS.UP },
      speed: 1.4 + idx * 0.05,
      baseSpeed: 1.4 + idx * 0.05,
      colorIndex: idx,
      state: 'pen',     // 'pen' | 'leaving' | 'chase' | 'scared' | 'eaten'
      stateTimer: idx * 1.2,
      personality: idx, // 0=direct,1=ambush,2=flank,3=random
    };
  }

  function newGoblins() {
    return [0, 1, 2, 3].map(newGoblin);
  }

  function startNewGame() {
    score = 0;
    level = 1;
    lives = 3;
    extraLifeAwarded = false;
    startLevel();
  }

  function startLevel() {
    resetMaze();
    player = newPlayer();
    goblins = newGoblins();
    bonus = null;
    bonusSpawned = 0;
    powerTimer = 0;
    goblinChain = 0;
    mode = 'ready';
    modeTimer = 1.8;
    showOverlay(`<div class="big">LEVEL ${level}</div><div>READY!</div>`);
    updateHud();
  }

  function loseLife() {
    lives--;
    updateHud();
    if (lives <= 0) {
      mode = 'gameover';
      modeTimer = 0;
      hiScore = Math.max(hiScore, score);
      localStorage.setItem('cowgillHi', String(hiScore));
      showOverlay('<div class="big">GAME OVER</div><div class="blink">PRESS SPACE TO RETRY</div>');
    } else {
      mode = 'ready';
      modeTimer = 1.6;
      player = newPlayer();
      goblins = newGoblins();
      powerTimer = 0;
      goblinChain = 0;
      showOverlay('<div class="big">READY!</div>');
    }
  }

  function levelComplete() {
    mode = 'levelup';
    modeTimer = 1.8;
    showOverlay(`<div class="big">LEVEL CLEAR!</div><div>+${level * 100} BONUS</div>`);
    score += level * 100;
    level++;
  }

  // ---------- Input ----------
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      if (mode === 'title' || mode === 'gameover') {
        startNewGame();
      } else if (mode === 'play') {
        paused = !paused;
        if (paused) showOverlay('<div class="big">PAUSED</div>');
        else hideOverlay();
      }
      return;
    }
    let d = null;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') d = DIRS.UP;
    else if (k === 'ArrowDown' || k === 's' || k === 'S') d = DIRS.DOWN;
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') d = DIRS.LEFT;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') d = DIRS.RIGHT;
    if (d && player) {
      e.preventDefault();
      setPlayerNext(d);
    }
  });

  function setPlayerNext(d) {
    if (!player) return;
    player.next = d;
    // immediate reverse is allowed any time
    if (player.dir.x === -d.x && player.dir.y === -d.y) player.dir = d;
  }

  // ---------- Touch / swipe input ----------
  const stage = document.getElementById('stage');
  let touchStart = null;
  let touchMoved = false;
  const SWIPE_THRESHOLD = 18; // CSS pixels

  function handleTap() {
    if (mode === 'title' || mode === 'gameover') {
      startNewGame();
    } else if (mode === 'play') {
      paused = !paused;
      if (paused) showOverlay('<div class="big">PAUSED</div><div class="blink">TAP TO RESUME</div>');
      else hideOverlay();
    } else if (paused) {
      paused = false;
      hideOverlay();
    }
  }

  function applySwipe(dx, dy) {
    let d;
    if (Math.abs(dx) > Math.abs(dy)) d = dx > 0 ? DIRS.RIGHT : DIRS.LEFT;
    else d = dy > 0 ? DIRS.DOWN : DIRS.UP;
    setPlayerNext(d);
  }

  stage.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    touchMoved = false;
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!touchStart) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_THRESHOLD) {
      applySwipe(dx, dy);
      touchStart = { x: t.clientX, y: t.clientY };
      touchMoved = true;
    }
  }, { passive: false });

  let lastTouchTs = 0;
  stage.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!touchMoved) handleTap();
    touchStart = null;
    touchMoved = false;
    lastTouchTs = Date.now();
  }, { passive: false });

  stage.addEventListener('touchcancel', () => {
    touchStart = null;
    touchMoved = false;
    lastTouchTs = Date.now();
  });

  // Mouse fallback for desktop (suppressed within 500ms of a touch).
  stage.addEventListener('click', () => {
    if (Date.now() - lastTouchTs > 500) handleTap();
  });

  // ---------- Movement helpers ----------
  function tryMove(e, who, dt) {
    if (e.dir.x === 0 && e.dir.y === 0) return;
    const speed = e.speed * 60 * dt; // pixels this frame
    let { x, y } = e;
    let nx = x + e.dir.x * speed;
    let ny = y + e.dir.y * speed;

    // Tunnel wrap (works for any horizontal motion through the tunnel row)
    if (nx < -TILE / 2) nx += W + TILE;
    else if (nx > W + TILE / 2) nx -= W + TILE;

    // Determine the tile we'd be entering (the one beyond our current cell in dir)
    const aheadCol = Math.floor((nx + e.dir.x * (TILE / 2 - 0.5)) / TILE);
    const aheadRow = Math.floor((ny + e.dir.y * (TILE / 2 - 0.5)) / TILE);

    if (blocked(aheadCol, aheadRow, who)) {
      // Snap to tile center on axis of travel and stop
      if (e.dir.x !== 0) {
        const cx = Math.floor(x / TILE) * TILE + TILE / 2;
        e.x = cx;
      } else {
        const cy = Math.floor(y / TILE) * TILE + TILE / 2;
        e.y = cy;
      }
      e.dir = { x: 0, y: 0 };
      return;
    }
    e.x = nx;
    e.y = ny;
  }

  function tryTurn(e, who, target) {
    // Only turn when reasonably centered on a tile
    if (!isCenteredOnTile(e, 2.5)) return false;
    const col = entityCol(e);
    const row = entityRow(e);
    const ahead = { col: col + target.x, row: row + target.y };
    if (blocked(ahead.col, ahead.row, who)) return false;
    snapToTile(e);
    e.dir = target;
    return true;
  }

  // ---------- Update logic ----------
  function update(dt) {
    if (mode === 'title' || mode === 'gameover' || paused) return;
    if (mode === 'ready' || mode === 'levelup' || mode === 'dying') {
      modeTimer -= dt;
      if (modeTimer <= 0) {
        if (mode === 'levelup') startLevel();
        else if (mode === 'dying') loseLife();
        else { mode = 'play'; hideOverlay(); }
      }
      return;
    }

    frame++;

    // --- Player ---
    if ((player.next.x !== 0 || player.next.y !== 0) &&
        (player.next.x !== player.dir.x || player.next.y !== player.dir.y)) {
      tryTurn(player, 'player', player.next);
    }
    if (player.dir.x !== 0 || player.dir.y !== 0) {
      tryMove(player, 'player', dt);
      if (player.dir.x !== 0) player.facing = player.dir.x < 0 ? 'left' : 'right';
      else if (player.dir.y !== 0) player.facing = player.dir.y < 0 ? 'up' : 'down';
      player.mouth = (player.mouth + dt * 8) % (Math.PI * 2);
    }

    // Eat pellets
    {
      const c = entityCol(player), r = entityRow(player);
      const t = tileAt(c, r);
      if (t === '.') {
        setTile(c, r, ' ');
        pelletsLeft--;
        score += SCORES.pellet;
      } else if (t === 'o') {
        setTile(c, r, ' ');
        pelletsLeft--;
        score += SCORES.superGem;
        powerTimer = POWER_DURATION_BY_LEVEL(level);
        goblinChain = 0;
        for (const g of goblins) {
          if (g.state === 'chase' || g.state === 'leaving') {
            g.state = 'scared';
            g.dir = { x: -g.dir.x, y: -g.dir.y };
          }
        }
      }
    }

    // Bonus spawn (random, per level)
    if (mode === 'play' && bonus == null && bonusSpawned < 2) {
      const eaten = totalPellets() - pelletsLeft;
      const triggers = [Math.floor(totalPellets() * 0.30), Math.floor(totalPellets() * 0.65)];
      if (eaten >= triggers[bonusSpawned]) {
        const kinds = ['horseshoe', 'star', 'boot', 'cactus'];
        const kind = kinds[Math.min(level - 1, kinds.length - 1)];
        bonus = {
          col: BONUS_SPOT.col,
          row: BONUS_SPOT.row,
          kind,
          points: SCORES.bonus[Math.min(level - 1, SCORES.bonus.length - 1)],
          expires: 9 + Math.random() * 3,
        };
        bonusSpawned++;
      }
    }
    if (bonus) {
      bonus.expires -= dt;
      if (bonus.expires <= 0) bonus = null;
      else if (entityCol(player) === bonus.col && entityRow(player) === bonus.row) {
        score += bonus.points;
        showFloater(bonus.col, bonus.row, '+' + bonus.points);
        bonus = null;
      }
    }

    // Power timer
    if (powerTimer > 0) {
      powerTimer -= dt;
      if (powerTimer <= 0) {
        powerTimer = 0;
        for (const g of goblins) if (g.state === 'scared') g.state = 'chase';
        goblinChain = 0;
      }
    }

    // --- Goblins ---
    for (const g of goblins) {
      updateGoblin(g, dt);
    }

    // Player <-> goblin collisions
    for (const g of goblins) {
      const dx = g.x - player.x, dy = g.y - player.y;
      if (dx * dx + dy * dy < (TILE * 0.7) * (TILE * 0.7)) {
        if (g.state === 'scared') {
          const pts = SCORES.goblin[Math.min(goblinChain, 3)];
          score += pts;
          goblinChain++;
          showFloater(Math.floor(g.x / TILE), Math.floor(g.y / TILE), '+' + pts);
          g.state = 'eaten';
          g.speed = g.baseSpeed * 1.8;
        } else if (g.state === 'chase' || g.state === 'leaving' || g.state === 'pen') {
          mode = 'dying';
          modeTimer = 1.5;
          player.alive = false;
          player.dir = { x: 0, y: 0 };
          showOverlay('<div class="big">CAUGHT!</div>');
          return;
        }
      }
    }

    // Extra life
    if (!extraLifeAwarded && score >= SCORES.extraLife) {
      extraLifeAwarded = true;
      lives++;
    }
    hiScore = Math.max(hiScore, score);

    if (pelletsLeft <= 0) {
      levelComplete();
    }

    updateHud();
  }

  function totalPellets() {
    let n = 0;
    for (const row of MAZE_TEMPLATE) {
      for (const ch of row) if (ch === '.' || ch === 'o') n++;
    }
    return n;
  }

  function targetForGoblin(g) {
    const pcol = entityCol(player), prow = entityRow(player);
    if (g.state === 'eaten') return GOBLIN_PEN;
    if (g.state === 'scared') {
      // Random-ish: target a corner away from player
      const corners = [{ col: 1, row: 1 }, { col: 17, row: 1 }, { col: 1, row: 19 }, { col: 17, row: 19 }];
      let best = corners[0], bestD = -1;
      for (const c of corners) {
        const d = Math.hypot(c.col - pcol, c.row - prow);
        if (d > bestD) { best = c; bestD = d; }
      }
      return best;
    }
    // Chase variations per personality
    switch (g.personality) {
      case 0: // direct
        return { col: pcol, row: prow };
      case 1: // 4 tiles ahead of player
        return { col: pcol + player.dir.x * 4, row: prow + player.dir.y * 4 };
      case 2: { // flank: mirror across player from goblin 0
        const lead = goblins[0];
        return { col: pcol * 2 - entityCol(lead), row: prow * 2 - entityRow(lead) };
      }
      case 3: { // chase if far, scatter if close
        const dist = Math.hypot(g.x - player.x, g.y - player.y);
        if (dist < TILE * 6) return { col: 1, row: 19 };
        return { col: pcol, row: prow };
      }
    }
    return { col: pcol, row: prow };
  }

  function updateGoblin(g, dt) {
    g.stateTimer = (g.stateTimer || 0) - dt;

    // Pen exit logic: stagger releases by personality
    if (g.state === 'pen') {
      // Wobble in pen
      if (g.stateTimer <= 0) {
        g.state = 'leaving';
        g.stateTimer = 0;
        g.dir = { x: 0, y: -1 };
      } else {
        // bob up and down inside pen
        if (Math.abs(g.y - g.home.row * TILE - TILE / 2) > 4) g.dir.y *= -1;
        g.y += g.dir.y * 30 * dt;
        return;
      }
    }
    if (g.state === 'leaving') {
      // Move toward gate (col 9) then up through it
      const targetX = GATE.col * TILE + TILE / 2;
      const targetY = (GATE.row - 1) * TILE + TILE / 2;
      if (Math.abs(g.x - targetX) > 1) {
        g.x += Math.sign(targetX - g.x) * g.baseSpeed * 60 * dt;
      } else {
        g.x = targetX;
        if (g.y > targetY) {
          g.y -= g.baseSpeed * 60 * dt;
        } else {
          g.y = targetY;
          g.state = powerTimer > 0 ? 'scared' : 'chase';
          g.dir = Math.random() < 0.5 ? DIRS.LEFT : DIRS.RIGHT;
          g.speed = g.baseSpeed * (powerTimer > 0 ? 0.7 : 1);
        }
      }
      return;
    }
    if (g.state === 'eaten') {
      // Head back to pen quickly
      const home = tileCenter(GOBLIN_PEN.col, GOBLIN_PEN.row);
      // First navigate to gate, then descend
      if (entityRow(g) < GATE.row) {
        // travel through maze toward gate using greedy AI
        navigateGoblin(g, GATE, dt, true);
      } else {
        // We're at/below gate level: drop into pen
        const tx = home.x;
        if (Math.abs(g.x - tx) > 1) g.x += Math.sign(tx - g.x) * g.baseSpeed * 60 * dt;
        else g.x = tx;
        if (g.y < home.y) g.y += g.baseSpeed * 60 * dt;
        else {
          g.y = home.y;
          g.state = 'leaving';
          g.speed = g.baseSpeed;
          g.stateTimer = 0;
        }
      }
      return;
    }

    // chase or scared
    const target = targetForGoblin(g);
    g.speed = g.state === 'scared' ? g.baseSpeed * 0.6 : g.baseSpeed * (1 + (level - 1) * 0.05);
    navigateGoblin(g, target, dt, false);
  }

  function navigateGoblin(g, target, dt, eaten) {
    // At intersections, choose direction toward target (no reverse).
    if (isCenteredOnTile(g, 1.5)) {
      const col = entityCol(g), row = entityRow(g);
      const choices = [];
      for (const d of ALL_DIRS) {
        if (d.x === -g.dir.x && d.y === -g.dir.y) continue;
        const nc = col + d.x, nr = row + d.y;
        if (eaten) {
          if (tileAt(nc, nr) === '#') continue;
        } else {
          if (blocked(nc, nr, 'goblin')) continue;
          // Don't re-enter the pen unless eaten
          if (tileAt(nc, nr) === '-') continue;
          if (nr === 9 && nc >= 8 && nc <= 10) continue;
        }
        choices.push({ d, dist: Math.hypot(nc - target.col, nr - target.row) });
      }
      if (choices.length > 0) {
        if (g.state === 'scared') {
          choices.sort(() => Math.random() - 0.5);
          g.dir = choices[0].d;
        } else {
          choices.sort((a, b) => a.dist - b.dist);
          g.dir = choices[0].d;
        }
        snapToTile(g);
      } else {
        // dead end: reverse
        g.dir = { x: -g.dir.x, y: -g.dir.y };
      }
    }
    // Move (custom because tryMove is for the player block logic)
    const speed = g.speed * 60 * dt;
    let nx = g.x + g.dir.x * speed;
    let ny = g.y + g.dir.y * speed;
    if (nx < -TILE / 2) nx += W + TILE;
    else if (nx > W + TILE / 2) nx -= W + TILE;
    const aheadCol = Math.floor((nx + g.dir.x * (TILE / 2 - 0.5)) / TILE);
    const aheadRow = Math.floor((ny + g.dir.y * (TILE / 2 - 0.5)) / TILE);
    if (eaten) {
      if (tileAt(aheadCol, aheadRow) === '#') {
        snapToTile(g);
        g.dir = { x: 0, y: 0 };
        return;
      }
    } else if (blocked(aheadCol, aheadRow, 'goblin')) {
      snapToTile(g);
      g.dir = { x: 0, y: 0 };
      return;
    }
    g.x = nx; g.y = ny;
  }

  // ---------- Floating score popups ----------
  const floaters = [];
  function showFloater(col, row, text) {
    floaters.push({ x: col * TILE + TILE / 2, y: row * TILE + TILE / 2, text, life: 1.0 });
  }

  // ---------- Drawing ----------
  function drawMaze() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = tileAt(c, r);
        const x = c * TILE, y = r * TILE;
        if (t === '#') {
          drawWallCell(c, r, x, y);
        } else if (t === '-') {
          ctx.fillStyle = '#ff7ad9';
          ctx.fillRect(x + 2, y + TILE / 2 - 2, TILE - 4, 4);
        } else if (t === '.') {
          ctx.fillStyle = COLORS.pellet;
          ctx.fillRect(x + TILE / 2 - 2, y + TILE / 2 - 2, 4, 4);
        } else if (t === 'o') {
          drawSuperGem(x + TILE / 2, y + TILE / 2);
        }
      }
    }
  }

  function drawWallCell(c, r, x, y) {
    // Pixel-block wall with brighter edges where neighbors aren't walls
    ctx.fillStyle = COLORS.wall;
    ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
    ctx.fillStyle = COLORS.wallEdge;
    // top
    if (tileAt(c, r - 1) !== '#') ctx.fillRect(x + 2, y + 2, TILE - 4, 2);
    // bottom
    if (tileAt(c, r + 1) !== '#') ctx.fillRect(x + 2, y + TILE - 4, TILE - 4, 2);
    // left
    if (tileAt(c - 1, r) !== '#') ctx.fillRect(x + 2, y + 2, 2, TILE - 4);
    // right
    if (tileAt(c + 1, r) !== '#') ctx.fillRect(x + TILE - 4, y + 2, 2, TILE - 4);
  }

  function drawSuperGem(cx, cy) {
    const t = (frame * 0.18) % (Math.PI * 2);
    const flicker = (Math.sin(t) + 1) / 2;
    const size = 5 + flicker * 2;
    ctx.fillStyle = COLORS.superGem;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size, cy);
    ctx.lineTo(cx, cy + size);
    ctx.lineTo(cx - size, cy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 1, cy - 2, 2, 2);
  }

  function drawPlayer() {
    if (!player) return;
    const x = player.x, y = player.y;
    const r = TILE / 2 - 2;
    // Body
    ctx.fillStyle = COLORS.cowgill;
    if (player.alive && (player.dir.x || player.dir.y)) {
      const open = (Math.sin(player.mouth) + 1) / 2 * 0.55 + 0.05;
      let baseAng = 0;
      if (player.facing === 'right') baseAng = 0;
      else if (player.facing === 'down') baseAng = Math.PI / 2;
      else if (player.facing === 'left') baseAng = Math.PI;
      else if (player.facing === 'up') baseAng = -Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r, baseAng + open, baseAng - open + Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Cowboy hat
    ctx.fillStyle = COLORS.hat;
    ctx.fillRect(x - 8, y - r - 1, 16, 3);  // brim
    ctx.fillRect(x - 5, y - r - 6, 10, 5);  // crown
    ctx.fillStyle = COLORS.bandana;
    ctx.fillRect(x - 4, y - r - 4, 8, 1);   // hatband
    // Eye
    if (player.alive) {
      ctx.fillStyle = '#222';
      let ex = x, ey = y - 3;
      if (player.facing === 'right') ex += 3;
      else if (player.facing === 'left') ex -= 3;
      else if (player.facing === 'down') ey += 1;
      ctx.fillRect(ex - 1, ey - 1, 2, 2);
    }
  }

  function drawGoblin(g) {
    const x = g.x, y = g.y;
    const r = TILE / 2 - 2;

    if (g.state === 'eaten') {
      // Just eyes flying
      drawGoblinEyes(x, y, g);
      return;
    }
    let body;
    if (g.state === 'scared') {
      const blinking = powerTimer < 2 && Math.floor(frame / 6) % 2 === 0;
      body = blinking ? COLORS.gobScaredEnd : COLORS.gobScared;
    } else {
      body = COLORS.gobBody[g.colorIndex % COLORS.gobBody.length];
    }
    ctx.fillStyle = body;
    // Domed top
    ctx.beginPath();
    ctx.arc(x, y - 1, r, Math.PI, 0);
    ctx.lineTo(x + r, y + r - 1);
    // skirt zigzag
    const teeth = 4;
    for (let i = teeth - 1; i >= 0; i--) {
      const px = x + r - ((teeth - i) * (2 * r / teeth));
      const py = y + r - ((i % 2 === 0) ? 0 : 4);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(x - r, y - 1);
    ctx.closePath();
    ctx.fill();

    // Pointy goblin ears
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x - r, y - 2);
    ctx.lineTo(x - r - 3, y - 8);
    ctx.lineTo(x - r + 2, y - 5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + r, y - 2);
    ctx.lineTo(x + r + 3, y - 8);
    ctx.lineTo(x + r - 2, y - 5);
    ctx.closePath();
    ctx.fill();

    if (g.state === 'scared') {
      // Frowny face
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 4, y - 2, 2, 2);
      ctx.fillRect(x + 2, y - 2, 2, 2);
      ctx.fillRect(x - 5, y + 4, 2, 1);
      ctx.fillRect(x - 2, y + 3, 2, 1);
      ctx.fillRect(x + 1, y + 4, 2, 1);
      ctx.fillRect(x + 4, y + 3, 2, 1);
    } else {
      drawGoblinEyes(x, y, g);
      // Little fang
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y + 4, 2, 3);
    }
  }

  function drawGoblinEyes(x, y, g) {
    ctx.fillStyle = COLORS.eyes;
    ctx.fillRect(x - 5, y - 3, 4, 5);
    ctx.fillRect(x + 1, y - 3, 4, 5);
    ctx.fillStyle = COLORS.pupils;
    let dx = 0, dy = 0;
    if (g.dir) { dx = Math.sign(g.dir.x); dy = Math.sign(g.dir.y); }
    ctx.fillRect(x - 4 + dx, y - 1 + dy, 2, 2);
    ctx.fillRect(x + 2 + dx, y - 1 + dy, 2, 2);
  }

  function drawBonus() {
    if (!bonus) return;
    const c = tileCenter(bonus.col, bonus.row);
    const x = c.x, y = c.y;
    const wob = Math.sin(frame * 0.2) * 1;
    if (bonus.kind === 'horseshoe') {
      ctx.fillStyle = '#bbbbbb';
      ctx.fillRect(x - 6, y - 5 + wob, 3, 8);
      ctx.fillRect(x + 3, y - 5 + wob, 3, 8);
      ctx.fillRect(x - 6, y + 1 + wob, 12, 3);
      ctx.fillStyle = '#777';
      ctx.fillRect(x - 5, y - 3 + wob, 2, 1);
      ctx.fillRect(x + 4, y - 3 + wob, 2, 1);
    } else if (bonus.kind === 'star') {
      ctx.fillStyle = COLORS.bonus;
      ctx.beginPath();
      const r = 7;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 === 0 ? r : r / 2;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr + wob);
      }
      ctx.closePath();
      ctx.fill();
    } else if (bonus.kind === 'boot') {
      ctx.fillStyle = '#7a3a12';
      ctx.fillRect(x - 4, y - 7 + wob, 5, 11);
      ctx.fillRect(x - 4, y + 2 + wob, 10, 3);
      ctx.fillStyle = '#cc8a3a';
      ctx.fillRect(x - 4, y - 6 + wob, 5, 1);
    } else if (bonus.kind === 'cactus') {
      ctx.fillStyle = '#3da35d';
      ctx.fillRect(x - 2, y - 8 + wob, 4, 14);
      ctx.fillRect(x - 6, y - 4 + wob, 3, 6);
      ctx.fillRect(x + 3, y - 2 + wob, 3, 6);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y - 5 + wob, 1, 1);
      ctx.fillRect(x + 1, y - 1 + wob, 1, 1);
    }
  }

  function drawFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      f.y -= 18 * dt;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(255,255,255,${f.life})`;
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y);
    }
  }

  function draw(dt) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawMaze();
    drawBonus();
    if (mode !== 'gameover') {
      for (const g of goblins || []) drawGoblin(g);
      drawPlayer();
    }
    drawFloaters(dt);

    // Power timer bar
    if (powerTimer > 0) {
      const max = POWER_DURATION_BY_LEVEL(level);
      const w = (powerTimer / max) * W;
      ctx.fillStyle = COLORS.gobScared;
      ctx.fillRect(0, H - 3, w, 3);
    }
  }

  // ---------- HUD / overlay ----------
  function pad(n, len) { return n.toString().padStart(len, '0'); }

  function updateHud() {
    $score.textContent = pad(score, 6);
    $hi.textContent = pad(hiScore, 6);
    $level.textContent = pad(level, 2);
    $lives.innerHTML = '';
    for (let i = 0; i < Math.max(0, lives); i++) {
      const d = document.createElement('span');
      d.className = 'life-icon';
      $lives.appendChild(d);
    }
  }

  function showOverlay(html) {
    overlay.innerHTML = html;
    overlay.classList.remove('hidden');
  }
  function hideOverlay() {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }

  // ---------- Main loop ----------
  let lastT = 0;
  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
    lastT = t;
    update(dt);
    draw(dt);
    requestAnimationFrame(loop);
  }

  function showTitle() {
    mode = 'title';
    score = 0;
    level = 1;
    lives = 3;
    resetMaze();
    player = null;
    goblins = [];
    bonus = null;
    powerTimer = 0;
    showOverlay(
      '<div class="big">COWGILL-MAN</div>' +
      '<div>RIDE THE MAZE. EAT THE GEMS.<br>STOMP THE GOBLINS.</div>' +
      '<div class="blink">PRESS SPACE TO START</div>'
    );
    updateHud();
  }

  showTitle();
  requestAnimationFrame(loop);
})();
