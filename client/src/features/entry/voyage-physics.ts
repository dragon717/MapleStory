// Presentation physics in metres/seconds. It does not own game movement or rewards.
export class ClothGrid {
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  readonly rest: Float32Array;
  readonly pinned: Uint8Array;
  private edges: [number, number, number, number][] = [];
  private pending = 0;
  constructor(rest: Float32Array, readonly columns: number, readonly rows: number, pins: boolean | readonly number[] = true) {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2 || columns > 64 || rows > 64 || rest.length !== (columns + 1) * (rows + 1) * 3 || !rest.every(Number.isFinite)) throw new Error('Invalid sail grid');
    this.positions = rest.slice(); this.previous = rest.slice(); this.rest = rest.slice();
    this.pinned = new Uint8Array(rest.length / 3);
    if (typeof pins !== 'boolean') {
      if (!pins.length || !pins.every(i => Number.isInteger(i) && i >= 0 && i < this.pinned.length)) throw new Error('Invalid sail attachments');
      for (const i of pins) this.pinned[i] = 1;
    }
    const edge = (a: number, b: number, stiffness: number) => {
      const distance = Math.hypot(...[0, 1, 2].map(axis => rest[a * 3 + axis] - rest[b * 3 + axis]));
      if (distance > 1e-7) this.edges.push([a, b, distance, stiffness]);
    };
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
      const i = y * (columns + 1) + x;
      if (typeof pins === 'boolean' && y === (pins ? rows : 0)) this.pinned[i] = 1;
      if (x < columns) edge(i, i + 1, 1);
      if (y < rows) edge(i, i + columns + 1, 1);
      if (x < columns && y < rows) { edge(i, i + columns + 2, .8); edge(i + 1, i + columns + 1, .8); }
      if (x + 2 <= columns) edge(i, i + 2, .12);
      if (y + 2 <= rows) edge(i, i + 2 * (columns + 1), .12);
    }
  }
  retarget(rest:Float32Array){
    if(rest.length!==this.rest.length||!rest.every(Number.isFinite))return;
    for(let k=0;k<rest.length;k++){const delta=rest[k]-this.rest[k];this.positions[k]+=delta;this.previous[k]+=delta;this.rest[k]=rest[k];}
    for(const edge of this.edges){const [a,b]=edge;edge[2]=Math.hypot(...[0,1,2].map(axis=>rest[a*3+axis]-rest[b*3+axis]));}
  }
  advance(delta: number, wind: readonly number[], gravity: readonly number[] = [0, -9.81, 0]) {
    if (!Number.isFinite(delta) || delta <= 0 || !wind.every(Number.isFinite) || !gravity.every(Number.isFinite)) return;
    // Fixed steps prevent a resumed tab from injecting a frame-sized gravity impulse.
    this.pending += Math.min(delta, .05);
    const dt = 1 / 120;
    while (this.pending >= dt) {
      this.pending -= dt;
      const p = this.positions, previous = this.previous;
      for (let i = 0; i < this.pinned.length; i++) for (let axis = 0; axis < 3; axis++) {
        const k = i * 3 + axis;
        if (this.pinned[i]) { p[k] = previous[k] = this.rest[k]; continue; }
        const value = p[k];
        p[k] += (p[k] - previous[k]) * .995 + (gravity[axis] + wind[axis]) * dt * dt;
        previous[k] = value;
      }
      for (let pass = 0; pass < 8; pass++) for (const [a, b, length, stiffness] of this.edges) {
        const wa = 1 - this.pinned[a], wb = 1 - this.pinned[b];
        if (!wa && !wb) continue;
        const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2];
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 1e-8) continue;
        const correction = (distance - length) / distance / (wa + wb) * stiffness;
        p[a * 3] += dx * correction * wa; p[b * 3] -= dx * correction * wb;
        p[a * 3 + 1] += dy * correction * wa; p[b * 3 + 1] -= dy * correction * wb;
        p[a * 3 + 2] += dz * correction * wa; p[b * 3 + 2] -= dz * correction * wb;
      }
    }
  }
}

/** Conservative finite-volume shallow water: h, h*u, h*v; Rusanov flux, flat bed.
 * ponytail: rectangular constant-depth domains; add well-balanced bathymetry when gameplay needs flooding.
 * References: Clawpack shallow-water Riemann book, linked in the water research report.
 */
export class ShallowWater {
  readonly state: Float64Array;
  private change: Float64Array;
  readonly dx: number;
  readonly dz: number;
  constructor(readonly columns: number, readonly rows: number, width: number, length: number, readonly depth: number, readonly flow = 0) {
    if (![columns, rows].every(n => Number.isInteger(n) && n >= 4 && n <= 96) || ![width, length, depth, flow].every(Number.isFinite) || width <= 0 || length <= 0 || depth < .1 || Math.abs(flow) > 20) throw new Error('Invalid water domain');
    this.dx = width / columns; this.dz = length / rows;
    this.state = new Float64Array(columns * rows * 3); this.change = this.state.slice();
    for (let i = 0; i < columns * rows; i++) { this.state[i * 3] = depth; this.state[i * 3 + 2] = depth * flow; }
  }
  disturb(u: number, v: number, strength = 2) {
    if (![u, v, strength].every(Number.isFinite)) return;
    for (let z = 0; z < this.rows; z++) for (let x = 0; x < this.columns; x++) {
      const du = x / (this.columns - 1) - u, dv = z / (this.rows - 1) - v;
      const weight = Math.exp(-(du * du + dv * dv) * 120) * Math.max(-5, Math.min(5, strength));
      const i = (z * this.columns + x) * 3;
      this.state[i + 1] += du * weight * this.state[i]; this.state[i + 2] += dv * weight * this.state[i];
    }
  }
  advance(delta: number, wind = 0) {
    if (!Number.isFinite(delta) || delta <= 0 || !Number.isFinite(wind)) return;
    let remaining = Math.min(delta, .05);
    const q = this.state, nx = this.columns, nz = this.rows;
    while (remaining > 1e-8) {
      let sx = 0, sz = 0;
      for (let i = 0; i < q.length; i += 3) { const c = Math.sqrt(9.81 * q[i]); sx = Math.max(sx, Math.abs(q[i + 1] / q[i]) + c); sz = Math.max(sz, Math.abs(q[i + 2] / q[i]) + c); }
      const dt = Math.min(remaining, .3 / (sx / this.dx + sz / this.dz)); remaining -= dt;
      this.change.fill(0);
      const flux = (left: number, right: number, axis: 1 | 2, cell: number) => {
        const inside = left < 0 ? right : left;
        const hL = q[left < 0 ? inside : left], hR = q[right < 0 ? inside : right];
        const momentum = (index: number, component: number, ghost: boolean) => q[index + component] * (ghost && component === axis ? -1 : 1);
        const l = left < 0 ? inside : left, r = right < 0 ? inside : right;
        let aL = momentum(l, axis, left < 0), aR = momentum(r, axis, right < 0);
        let tL = momentum(l, axis === 1 ? 2 : 1, false), tR = momentum(r, axis === 1 ? 2 : 1, false);
        let dL = hL, dR = hR;
        // Channels have reservoir inflow/outflow; basin walls reflect normal momentum.
        if (this.flow && axis === 2) {
          if (left < 0) { dL = this.depth; aL = dL * this.flow; tL = 0; }
          if (right < 0) { dR = this.depth; aR = dR * this.flow; tR = 0; }
        }
        const speed = Math.max(Math.abs(aL / dL) + Math.sqrt(9.81 * dL), Math.abs(aR / dR) + Math.sqrt(9.81 * dR));
        const statesL = [dL, aL, tL], statesR = [dR, aR, tR];
        const fL = [aL, aL * aL / dL + 4.905 * dL * dL, aL * tL / dL];
        const fR = [aR, aR * aR / dR + 4.905 * dR * dR, aR * tR / dR];
        for (let component = 0; component < 3; component++) {
          const slot = component === 0 ? 0 : component === 1 ? axis : axis === 1 ? 2 : 1;
          const value = (.5 * (fL[component] + fR[component]) - .5 * speed * (statesR[component] - statesL[component])) * dt / cell;
          if (left >= 0) this.change[left + slot] -= value;
          if (right >= 0) this.change[right + slot] += value;
        }
      };
      for (let z = 0; z < nz; z++) for (let x = 0; x <= nx; x++) flux(x ? (z * nx + x - 1) * 3 : -1, x < nx ? (z * nx + x) * 3 : -1, 1, this.dx);
      for (let z = 0; z <= nz; z++) for (let x = 0; x < nx; x++) flux(z ? ((z - 1) * nx + x) * 3 : -1, z < nz ? (z * nx + x) * 3 : -1, 2, this.dz);
      for (let i = 0; i < q.length; i += 3) {
        q[i] = Math.max(.001, q[i] + this.change[i]);
        const damping = Math.exp(-.16 * dt);
        q[i + 1] = (q[i + 1] + this.change[i + 1] + wind * q[i] * dt) * damping;
        q[i + 2] = (q[i + 2] + this.change[i + 2]) * damping;
      }
    }
  }
  height(u: number, v: number) {
    const x = Math.max(0, Math.min(this.columns - 1, Math.round(u * (this.columns - 1))));
    const z = Math.max(0, Math.min(this.rows - 1, Math.round(v * (this.rows - 1))));
    return this.state[(z * this.columns + x) * 3] - this.depth;
  }
}
