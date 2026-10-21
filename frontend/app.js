const DEMO_PASSWORD = "demo-password";
const DEMO_ACCOUNTS = [
  { name: "Adam", email: "adam@example.com" },
  { name: "Ben", email: "ben@example.com" },
];
const ARENA_TITLE = "Flash Sale Arena";
const REFRESH_MS = 4000;
const TONES = 4;
const LOG_LIMIT = 60;
const HIDDEN_FIELDS = new Set(["password", "access_token", "refresh_token"]);

const state = {
  token: localStorage.getItem("token"),
  user: null,
  holds: new Map(),
  timers: [],
  socket: null,
  returnTo: "#/",
  requests: [],
  sent: 0,
  lab: null,
};

const view = document.querySelector("#view");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const money = (cents) =>
  (cents / 100).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });

const when = (iso) => {
  const date = new Date(iso);
  return date.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
};

const poster = (event) => `
  <div class="poster">
    <span class="poster-date">
      ${new Date(event.starts_at).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
    </span>
    <strong>${esc(event.category)}</strong>
  </div>`;

const tone = (text) =>
  [...String(text)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TONES;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const describe = (detail) =>
  Array.isArray(detail)
    ? detail.map((item) => item.msg.replace(/^Value error, /, "")).join(". ")
    : detail;

async function refreshSession() {
  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) {
    return false;
  }
  const response = await fetch("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) {
    return false;
  }
  state.token = (await response.json()).access_token;
  localStorage.setItem("token", state.token);
  return true;
}

const nameOf = (email) =>
  DEMO_ACCOUNTS.find((account) => account.email === email)?.name ?? email?.split("@")[0];

const hideSecrets = (value) =>
  value && typeof value === "object"
    ? JSON.parse(JSON.stringify(value, (key, field) => (HIDDEN_FIELDS.has(key) ? "(hidden)" : field)))
    : value;

async function send(path, { method = "GET", body, headers = {}, token = state.token, who } = {}) {
  const started = performance.now();
  const response = await fetch(path, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  const key = headers["Idempotency-Key"];
  const caller = who ?? (token ? (nameOf(state.user?.email) ?? "you") : "guest");
  record({
    method,
    path,
    key,
    who: caller,
    status: response.status,
    ms: Math.round(performance.now() - started),
    sent: hideSecrets(body),
    received: hideSecrets(data),
    replay: key && { method, body, headers, token, who: caller },
  });
  return { response, data };
}

async function api(path, options = {}, retried = false) {
  const { response, data } = await send(path, options);
  if (response.status === 401 && state.token) {
    if (!retried && (await refreshSession())) {
      return api(path, options, true);
    }
    signOut();
    toast("Your session ended. Please sign in again.", "info");
  }
  if (!response.ok) {
    throw new Error(describe(data?.detail) || `Request failed with status ${response.status}`);
  }
  return data;
}

function toast(message, kind = "error") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 4500);
}

const attempt = (action) => action().catch((error) => toast(error.message));

async function renderNav() {
  const auth = document.querySelector("#auth");
  if (!state.token) {
    showAdmin();
    auth.innerHTML = `<a class="button small" href="#/login">Sign in</a>`;
    return;
  }
  state.user ??= await api("/auth/me").catch(() => null);
  showAdmin();
  if (!state.user) {
    return;
  }
  auth.innerHTML = `
    <span class="who">
      <span class="avatar">${esc(state.user.email[0])}</span>
      <span>${esc(state.user.email)}</span>
    </span>
    <button class="secondary small" id="signout">Sign out</button>`;
  document.querySelector("#signout").onclick = () => {
    signOut();
    location.hash = "#/";
  };
}

function showAdmin() {
  document.body.classList.toggle("admin", state.user?.role === "admin");
  movePill(currentLink());
}

async function signIn(email, password) {
  const tokens = await api("/auth/login", { method: "POST", body: { email, password } });
  state.token = tokens.access_token;
  state.user = null;
  localStorage.setItem("token", state.token);
  localStorage.setItem("refresh_token", tokens.refresh_token);
  if (DEMO_ACCOUNTS.some((account) => account.email === email.trim().toLowerCase())) {
    await cancelAllBookings();
  }
  tick("signin");
  await renderNav();
  location.hash = state.returnTo;
  state.returnTo = "#/";
}

async function cancelAllBookings() {
  const page = await api("/bookings?limit=100");
  await Promise.all(
    page.items.map((booking) => api(`/bookings/${booking.id}`, { method: "DELETE" })),
  );
}

function signOut() {
  state.token = null;
  state.user = null;
  state.holds.clear();
  localStorage.removeItem("token");
  localStorage.removeItem("refresh_token");
  renderNav();
}

function requireSignIn(returnTo) {
  state.returnTo = returnTo;
  location.hash = "#/login";
}

const heroTicket = () => `
  <div class="ticket hero-ticket tilt" aria-hidden="true">
    <div class="ticket-top"><strong>Flash sale</strong><span>Admit one</span></div>
    <div class="mini-stage"></div>
    <div class="mini-seats">
      ${Array.from({ length: 50 }, (_, n) => `<i style="--d:${(n * 37) % 23}"></i>`).join("")}
    </div>
    <div class="ticket-bottom"><span>Seats sold twice</span><strong>0</strong></div>
  </div>`;

const STEPS = [
  ["Pick", "Choose seats on a live map that updates the moment someone else holds or books."],
  ["Hold", "All-or-nothing: you get every seat you asked for, or none of them."],
  ["Confirm", "Book before the two-minute timer runs out, or the seats go back on sale."],
];

const UNDER_THE_HOOD = [
  ["A unique key, not a check", "Every held or booked seat is a row keyed by its seat id, so Postgres itself refuses a second claim."],
  ["One transaction per hold", "All requested seats are claimed together. If one is already taken, none of them are held."],
  ["Expiry on the database clock", "A hold stores when it ends, and every read compares that with the database's own time. No cleanup job needed."],
  ["Safe retries", "Holding and confirming take an Idempotency-Key, so sending the same request twice returns the first result."],
];

async function renderEvents() {
  view.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow"><i class="pulse"></i>Live seat map over WebSockets</span>
        <h1>Grab the seat <mark>before anyone else</mark> does.</h1>
        <p class="lead">Hundreds of buyers, a handful of seats, and a database that never sells
        the same seat twice. Hold your seats for two minutes and confirm before the timer runs out.</p>
        <div class="actions">
          <button id="browse">Browse events <span class="arrow">&rarr;</span></button>
          ${
            state.token
              ? `<a class="button secondary" href="#/bookings">My bookings</a>`
              : `<a class="button secondary" href="#/login">Try the demo</a>`
          }
        </div>
      </div>
      ${heroTicket()}
    </section>
    <div id="featured"></div>
    <div class="section-head" id="on-sale">
      <div><span class="kicker">Tickets</span><h2>On sale now</h2></div>
      <span class="muted" id="count"></span>
    </div>
    <div class="grid" id="events">${`<div class="skeleton"></div>`.repeat(6)}</div>
    <div class="section-head">
      <div><span class="kicker">How it works</span><h2>Three steps, two minutes</h2></div>
    </div>
    <ol class="steps">
      ${STEPS.map(
        ([title, text], index) => `
          <li class="tone-${index}" style="--i:${index}">
            <small>0${index + 1}</small><strong>${title}</strong><span>${text}</span>
          </li>`,
      ).join("")}
    </ol>
    <div class="section-head">
      <div><span class="kicker">Under the hood</span><h2>Rules the database enforces</h2></div>
      <a class="link admin-only" href="#/lab">Watch them in the rules lab <span class="arrow">&rarr;</span></a>
    </div>
    <div class="hood">
      ${UNDER_THE_HOOD.map(
        ([title, text], index) => `
          <div class="hood-card tone-${index}" style="--i:${index}">
            <strong>${title}</strong><span>${text}</span>
          </div>`,
      ).join("")}
    </div>`;
  document.querySelector("#browse").onclick = () =>
    document.querySelector("#on-sale").scrollIntoView({ behavior: "smooth" });
  const page = await api("/events?limit=50");
  const featured = page.items.find(isOnSale) ?? page.items[0];
  if (featured) {
    document.querySelector("#featured").outerHTML = featuredEvent(featured);
  }
  document.querySelector("#count").textContent = plural(page.items.length, "event");
  document.querySelector("#events").innerHTML = page.items.length
    ? page.items.map(eventCard).join("")
    : `<p class="empty">No events on sale right now.</p>`;
}

const isOnSale = (event) => new Date(event.sale_starts_at) <= new Date();

const featuredEvent = (event) => `
  <section class="ticket featured spotlight tone-${tone(event.category)}">
    <div class="featured-copy">
      <span class="kicker">Featured</span>
      <p class="muted">${when(event.starts_at)}</p>
      <h2>${esc(event.title)}</h2>
      <p class="muted">${esc(event.venue)}, ${esc(event.city)}</p>
      <p class="price">${money(event.min_price_cents)} onwards</p>
      <a class="button" href="#/events/${event.id}">
        ${isOnSale(event) ? "Book tickets" : "View seats"} <span class="arrow">&rarr;</span>
      </a>
    </div>
    ${poster(event)}
  </section>`;

function eventCard(event, index) {
  const onSale = isOnSale(event);
  return `
    <a class="ticket event-card spotlight tone-${tone(event.category)}" href="#/events/${event.id}" style="--i:${index}">
      ${poster(event)}
      <div class="ticket-main">
        <h3>${esc(event.title)}</h3>
        <p class="muted">${esc(event.venue)}, ${esc(event.city)}</p>
        <p class="muted">${when(event.starts_at)}</p>
      </div>
      <div class="ticket-stub">
        <span>from <strong>${money(event.min_price_cents)}</strong></span>
        <span class="badge ${onSale ? "live" : ""}">
          ${onSale ? "On sale" : `Opens ${when(event.sale_starts_at)}`}
        </span>
      </div>
    </a>`;
}

async function renderEvent(id) {
  const event = await api(`/events/${id}`);
  const onSale = isOnSale(event);
  view.innerHTML = `
    <a class="back" href="#/"><span>&larr;</span> All events</a>
    <header class="event-head tone-${tone(event.category)}">
      ${poster(event)}
      <div>
        <span class="tag">${esc(event.category)}</span>
        <h1>${esc(event.title)}</h1>
        <p class="meta">
          <span>${esc(event.venue)}, ${esc(event.city)}</span>
          <span>${when(event.starts_at)}</span>
          <span class="badge ${onSale ? "live" : ""}">${onSale ? "On sale" : `Opens ${when(event.sale_starts_at)}`}</span>
        </p>
        <p class="muted">${esc(event.description)}</p>
      </div>
    </header>
    <div class="layout">
      <section class="panel">
        <div class="panel-head">
          <h2>Choose your seats</h2>
          <span class="live-dot" id="live">Connecting</span>
        </div>
        <div class="stage">Stage</div>
        <div id="seatmap" class="seatmap"></div>
        <div class="legend">
          <span><i class="seat available"></i>Available</span>
          <span><i class="seat selected"></i>Selected</span>
          <span><i class="seat mine"></i>Your hold</span>
          <span><i class="seat held"></i>Held by others</span>
          <span><i class="seat booked"></i>Booked</span>
        </div>
      </section>
      <aside class="panel checkout" id="checkout"></aside>
    </div>`;

  const seatMapNode = document.querySelector("#seatmap");
  const checkout = document.querySelector("#checkout");
  const selected = new Set();
  const seats = new Map();
  const heldUntil = new Map();
  const touched = new Set();
  let seatMap = null;
  let booking = null;

  const currentHold = () => state.holds.get(event.id);

  function index() {
    const tiers = new Map(seatMap.price_tiers.map((tier) => [tier.id, tier]));
    seats.clear();
    for (const section of seatMap.sections) {
      for (const row of section.rows) {
        for (const seat of row.seats) {
          seats.set(seat.id, {
            ...seat,
            label: `${section.name} ${row.label}${seat.number}`,
            tier: tiers.get(seat.price_tier_id),
          });
        }
      }
    }
  }

  function seatButton(seat, mine) {
    const info = seats.get(seat.id);
    const status = mine.has(seat.id) ? "mine" : selected.has(seat.id) ? "selected" : seat.status;
    const title = `${info.label} · ${info.tier.name} ${money(info.tier.price_cents)}`;
    return `<button class="seat ${status}" data-seat="${seat.id}" title="${esc(title)}"
      aria-label="${esc(title)}" ${seat.status === "available" ? "" : "disabled"}>${seat.number}</button>`;
  }

  function drawSeats() {
    const mine = new Set(currentHold()?.seat_ids ?? []);
    seatMapNode.innerHTML = seatMap.sections
      .map(
        (section) => `
          <div class="section">
            <h3>${esc(section.name)}</h3>
            ${section.rows
              .map(
                (row) => `
                  <div class="row">
                    <span class="row-label">${esc(row.label)}</span>
                    ${row.seats.map((seat) => seatButton(seat, mine)).join("")}
                  </div>`,
              )
              .join("")}
          </div>`,
      )
      .join("");
  }

  const lines = (items) => `
    <ul class="lines">
      ${items.map((seat) => `<li><span>${esc(seat.label)}</span><span>${money(seat.tier.price_cents)}</span></li>`).join("")}
    </ul>
    <p class="total"><span>Total</span><span>${money(items.reduce((sum, seat) => sum + seat.tier.price_cents, 0))}</span></p>`;

  const tierList = () => `
    <ul class="lines">
      ${seatMap.price_tiers.map((tier) => `<li><span>${esc(tier.name)}</span><span>${money(tier.price_cents)}</span></li>`).join("")}
    </ul>`;

  function setStatus(seatIds, status) {
    for (const section of seatMap.sections) {
      for (const row of section.rows) {
        for (const seat of row.seats) {
          if (seatIds.includes(seat.id)) {
            seat.status = status;
          }
        }
      }
    }
    update();
  }

  function applyUpdate({ status, seat_ids, expires_in }) {
    for (const seatId of seat_ids) {
      if (expires_in) {
        heldUntil.set(seatId, Date.now() + expires_in * 1000);
      } else {
        heldUntil.delete(seatId);
      }
    }
    setStatus(seat_ids, status);
  }

  function expireHeldSeats() {
    const expired = [...heldUntil].filter(([, until]) => until <= Date.now()).map(([seatId]) => seatId);
    if (expired.length) {
      expired.forEach((seatId) => heldUntil.delete(seatId));
      setStatus(expired, "available");
    }
  }

  function tick() {
    expireHeldSeats();
    const hold = currentHold();
    const node = document.querySelector("#countdown");
    if (!hold || !node) {
      return;
    }
    const left = Math.max(0, Math.round((new Date(hold.expires_at) - Date.now()) / 1000));
    node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    document.querySelector("#bar").style.width = `${Math.min(100, (left * 100000) / hold.duration)}%`;
    document.querySelector(".timer").classList.toggle("low", left < 60);
    if (left === 0) {
      state.holds.delete(event.id);
      toast("Your hold expired, so the seats went back on sale.", "info");
      attempt(refresh);
    }
  }

  function drawBooked() {
    checkout.innerHTML = `
      <span class="kicker">Confirmed</span>
      <h2>You're going.</h2>
      <p class="muted">Booking #${booking.id} for ${plural(booking.seat_ids.length, "seat")}.</p>
      <p class="total"><span>Paid</span><span>${money(booking.total_cents)}</span></p>
      <a class="button" href="#/bookings">View my bookings <span class="arrow">&rarr;</span></a>
      <button class="secondary" id="again">Book more seats</button>`;
    document.querySelector("#again").onclick = () => {
      booking = null;
      draw();
    };
  }

  function drawHold(hold) {
    checkout.innerHTML = `
      <span class="kicker">Your hold</span>
      <h2>Seats reserved</h2>
      <div class="timer">
        <p class="countdown" id="countdown"></p>
        <div class="bar"><i id="bar"></i></div>
      </div>
      ${lines(hold.seat_ids.map((seatId) => seats.get(seatId)))}
      <button id="confirm">Confirm booking <span class="arrow">&rarr;</span></button>
      <button class="secondary" id="release">Release seats</button>`;
    tick();
    document.querySelector("#confirm").onclick = (click) => {
      click.currentTarget.disabled = true;
      hold.seat_ids.forEach((seatId) => touched.add(seatId));
      attempt(async () => {
        try {
          booking = await api(`/holds/${hold.id}/confirm`, {
            method: "POST",
            headers: { "Idempotency-Key": hold.confirmKey },
          });
          state.holds.delete(event.id);
          tick("book");
          toast("Booking confirmed.", "ok");
        } finally {
          await refresh();
        }
      });
    };
    document.querySelector("#release").onclick = () =>
      attempt(async () => {
        hold.seat_ids.forEach((seatId) => touched.add(seatId));
        await api(`/holds/${hold.id}`, { method: "DELETE" });
        state.holds.delete(event.id);
        toast("Seats released.", "info");
        await refresh();
      });
  }

  function drawSelection() {
    const items = [...selected].map((seatId) => seats.get(seatId));
    checkout.innerHTML = `
      <span class="kicker">Selection</span>
      <h2>${plural(items.length, "seat")} selected</h2>
      ${lines(items)}
      <button id="hold">${state.token ? "Hold seats" : "Sign in to hold seats"} <span class="arrow">&rarr;</span></button>
      <button class="secondary" id="clear">Clear selection</button>`;
    document.querySelector("#clear").onclick = () => {
      selected.clear();
      draw();
    };
    document.querySelector("#hold").onclick = (click) => {
      if (!state.token) {
        requireSignIn(`#/events/${event.id}`);
        return;
      }
      click.currentTarget.disabled = true;
      selected.forEach((seatId) => touched.add(seatId));
      attempt(async () => {
        try {
          const hold = await api(`/events/${event.id}/holds`, {
            method: "POST",
            body: { seat_ids: [...selected] },
            headers: { "Idempotency-Key": crypto.randomUUID() },
          });
          state.holds.set(event.id, {
            ...hold,
            confirmKey: crypto.randomUUID(),
            duration: new Date(hold.expires_at) - Date.now(),
          });
          selected.clear();
          tick("hold");
          toast("Seats held. Confirm before the timer runs out.", "ok");
        } finally {
          await refresh();
        }
      });
    };
  }

  function drawCheckout() {
    const hold = currentHold();
    if (booking) {
      drawBooked();
    } else if (hold) {
      drawHold(hold);
    } else if (!onSale) {
      checkout.innerHTML = `
        <span class="kicker">Coming soon</span>
        <h2>Sale not open yet</h2>
        <p class="muted">Seats can be held from ${when(event.sale_starts_at)}.</p>
        ${tierList()}`;
    } else if (selected.size === 0) {
      checkout.innerHTML = `
        <span class="kicker">Checkout</span>
        <h2>Pick your seats</h2>
        <p class="muted">Holds are all-or-nothing: if anyone takes one of your seats first, none of them are held.</p>
        ${tierList()}`;
    } else {
      drawSelection();
    }
  }

  function draw() {
    drawSeats();
    drawCheckout();
  }

  function update() {
    index();
    for (const seatId of selected) {
      if (seats.get(seatId)?.status !== "available") {
        selected.delete(seatId);
      }
    }
    draw();
  }

  async function refresh() {
    seatMap = await api(`/events/${event.id}/seatmap`);
    heldUntil.clear();
    update();
  }

  function showLive(on) {
    const node = document.querySelector("#live");
    node?.classList.toggle("on", on);
    if (node) {
      node.textContent = on ? "Live" : "Reconnecting";
    }
  }

  function connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/events/${event.id}/seatmap/ws`);
    state.socket = socket;
    socket.onopen = () => showLive(true);
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.sections) {
        seatMap = data;
        heldUntil.clear();
        update();
      } else {
        if (data.seat_ids.some((seatId) => !touched.has(seatId))) {
          tick("live");
        }
        applyUpdate(data);
      }
    };
    socket.onclose = () => {
      if (state.socket === socket) {
        showLive(false);
        state.timers.push(setTimeout(connect, 3000));
      }
    };
  }

  seatMapNode.onclick = (click) => {
    const button = click.target.closest("button.seat");
    if (!button || button.disabled || !onSale) {
      return;
    }
    const seatId = Number(button.dataset.seat);
    if (selected.has(seatId)) {
      selected.delete(seatId);
    } else {
      selected.add(seatId);
    }
    draw();
  };

  await refresh();
  connect();
  state.timers.push(
    setInterval(() => {
      if (state.socket?.readyState !== WebSocket.OPEN) {
        refresh().catch(() => {});
      }
    }, REFRESH_MS),
    setInterval(tick, 1000),
  );
}

async function renderLogin() {
  view.innerHTML = `
    <section class="auth">
      <div class="auth-copy">
        <span class="kicker">Account</span>
        <h1>Sign in and <mark>beat the queue.</mark></h1>
        <p class="lead">Hold seats, confirm bookings and cancel them as one of the two demo buyers.</p>
      </div>
      <div class="panel spotlight">
        <div class="demo">
          <span class="kicker">Demo buyers</span>
          <div class="accounts">
            ${DEMO_ACCOUNTS.map(
              (account) => `
                <button class="account" data-account="${account.email}">
                  <span class="avatar">${account.name[0]}</span>
                  <span><strong>Continue as ${account.name}</strong><small>${account.email}</small></span>
                  <span class="arrow">&rarr;</span>
                </button>`,
            ).join("")}
          </div>
          <p class="muted">Password for both: <code>${DEMO_PASSWORD}</code>. Their bookings are cleared on every
          sign-in, so you always start clean. Open the other one in a private window to watch each other's seats change live.</p>
        </div>
        <div class="divider">or sign in with your account</div>
        <form id="login" class="stack">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </section>`;
  const form = document.querySelector("#login");
  form.onsubmit = (submit) => {
    submit.preventDefault();
    const { email, password } = Object.fromEntries(new FormData(form));
    attempt(() => signIn(email, password));
  };
  document.querySelector(".accounts").onclick = (click) => {
    const email = click.target.closest("[data-account]")?.dataset.account;
    if (email) {
      attempt(() => signIn(email, DEMO_PASSWORD));
    }
  };
}

async function renderBookings() {
  if (!state.token) {
    requireSignIn("#/bookings");
    return;
  }
  const page = await api("/bookings?limit=50");
  const eventIds = [...new Set(page.items.map((booking) => booking.event_id))];
  const events = await Promise.all(eventIds.map((eventId) => api(`/events/${eventId}`)));
  const byId = new Map(events.map((event) => [event.id, event]));
  view.innerHTML = `
    <div class="page-head">
      <div><span class="kicker">Your tickets</span><h1>My bookings</h1></div>
      <span class="muted">${plural(page.items.length, "booking")}</span>
    </div>
    ${
      page.items.length
        ? `<div class="list">${page.items
            .map((booking, index) => {
              const event = byId.get(booking.event_id);
              return `
                <div class="ticket booking tone-${tone(event.category)}" style="--i:${index}">
                  <div class="booking-main">
                    <span class="booking-id">#${booking.id}</span>
                    <div>
                      <a href="#/events/${booking.event_id}"><strong>${esc(event.title)}</strong></a>
                      <p class="muted">${plural(booking.seat_ids.length, "seat")} &middot; booked ${when(booking.created_at)}</p>
                    </div>
                  </div>
                  <div class="booking-stub">
                    <strong>${money(booking.total_cents)}</strong>
                    <button class="secondary small" data-cancel="${booking.id}">Cancel</button>
                  </div>
                </div>`;
            })
            .join("")}</div>`
        : `<p class="empty">No bookings yet. <a class="link" href="#/">Find an event</a>.</p>`
    }`;
  view.onclick = (click) => {
    const bookingId = click.target.closest("[data-cancel]")?.dataset.cancel;
    if (!bookingId || !confirm(`Cancel booking #${bookingId}? Its seats go back on sale.`)) {
      return;
    }
    attempt(async () => {
      await api(`/bookings/${bookingId}`, { method: "DELETE" });
      tick("cancel");
      toast("Booking cancelled. The seats are available again.", "ok");
      await renderBookings();
    });
  };
}

const outcome = ({ response, data }) =>
  `${response.status}${data?.detail ? ` "${describe(data.detail)}"` : ""}`;

const tally = (results) =>
  Object.entries(
    results.reduce((counts, { response }) => ({ ...counts, [response.status]: (counts[response.status] ?? 0) + 1 }), {}),
  )
    .map(([status, count]) => `${count} × ${status}`)
    .join(", ");

const LAB = [
  {
    title: "One seat, twenty buyers",
    rule: "A seat can be sold only once. Postgres enforces it with a unique key on the seat.",
    async run({ adam, ben, holdSeats, seats, statusOf, log, cleanup }) {
      const [seat] = await seats(1);
      log(`20 hold requests for seat ${seat.label} sent at the same moment, 10 as Adam and 10 as Ben`);
      const buyers = Array.from({ length: 20 }, (_, n) => (n % 2 ? ben : adam));
      const results = await Promise.all(buyers.map((buyer) => holdSeats(buyer, [seat])));
      results.forEach((result, n) => {
        if (result.response.status === 201) {
          cleanup(() => buyers[n].as(`/holds/${result.data.id}`, { method: "DELETE" }));
        }
      });
      const accepted = results.filter(({ response }) => response.status === 201).length;
      log(`Answers: ${tally(results)}`);
      const status = await statusOf(seat);
      log(`${plural(accepted, "buyer")} got the seat, and seat ${seat.label} is now ${status}`);
      return accepted === 1 && status === "held";
    },
  },
  {
    title: "All or nothing",
    rule: "A hold gets every seat asked for, or none of them.",
    async run({ adam, ben, holdSeats, seats, statusOf, log, cleanup }) {
      const picked = await seats(4);
      const taken = picked[2];
      const benHold = await holdSeats(ben, [taken]);
      cleanup(() => ben.as(`/holds/${benHold.data.id}`, { method: "DELETE" }));
      log(`Ben holds ${taken.label}: ${outcome(benHold)}`);
      const adamHold = await holdSeats(adam, picked);
      if (adamHold.response.status === 201) {
        cleanup(() => adam.as(`/holds/${adamHold.data.id}`, { method: "DELETE" }));
      }
      log(`Adam asks for ${picked.map((seat) => seat.label).join(", ")}: ${outcome(adamHold)}`);
      const others = picked.filter((seat) => seat !== taken);
      const statuses = await Promise.all(others.map(statusOf));
      log(`${others.map((seat) => seat.label).join(", ")} are still ${[...new Set(statuses)].join(" and ")}`);
      return adamHold.response.status === 409 && statuses.every((status) => status === "available");
    },
  },
  {
    title: "Only the holder can confirm",
    rule: "A hold belongs to the person who made it. Nobody else can turn it into a booking.",
    async run({ adam, ben, holdSeats, seats, log, cleanup }) {
      const [seat] = await seats(1);
      const hold = await holdSeats(adam, [seat]);
      let bookingId = null;
      cleanup(() =>
        bookingId
          ? adam.as(`/bookings/${bookingId}`, { method: "DELETE" })
          : adam.as(`/holds/${hold.data.id}`, { method: "DELETE" }),
      );
      log(`Adam holds ${seat.label}: hold #${hold.data.id}`);
      const benTry = await ben.as(`/holds/${hold.data.id}/confirm`, { method: "POST" });
      log(`Ben tries to confirm Adam's hold: ${outcome(benTry)}`);
      const adamTry = await adam.as(`/holds/${hold.data.id}/confirm`, { method: "POST" });
      bookingId = adamTry.data?.id ?? null;
      log(`Adam confirms his own hold: ${outcome(adamTry)}${bookingId ? `, booking #${bookingId}` : ""}`);
      return benTry.response.status === 404 && adamTry.response.status === 200;
    },
  },
  {
    title: "Seat limit per buyer",
    rule: "One buyer can hold or book at most 6 seats for an event.",
    async run({ adam, holdSeats, seats, log, cleanup }) {
      const picked = await seats(7);
      const result = await holdSeats(adam, picked);
      if (result.response.status === 201) {
        cleanup(() => adam.as(`/holds/${result.data.id}`, { method: "DELETE" }));
      }
      log(`Adam asks for 7 seats at once: ${outcome(result)}`);
      return result.response.status === 409 && /seat limit/.test(result.data?.detail);
    },
  },
  {
    title: "Safe retries",
    rule: "Sending the same hold or confirm twice with one Idempotency-Key returns the first result instead of acting twice.",
    async run({ adam, holdSeats, seats, log, cleanup }) {
      const [seat] = await seats(1);
      const holdKey = crypto.randomUUID();
      const first = await holdSeats(adam, [seat], holdKey);
      const second = await holdSeats(adam, [seat], holdKey);
      log(`Hold sent twice with key ${holdKey.slice(0, 8)}: hold #${first.data.id}, then hold #${second.data.id}`);
      const confirmKey = crypto.randomUUID();
      const confirm = () =>
        adam.as(`/holds/${first.data.id}/confirm`, { method: "POST", headers: { "Idempotency-Key": confirmKey } });
      const booked = await confirm();
      const again = await confirm();
      cleanup(() =>
        booked.data?.id
          ? adam.as(`/bookings/${booked.data.id}`, { method: "DELETE" })
          : adam.as(`/holds/${first.data.id}`, { method: "DELETE" }),
      );
      log(`Confirm sent twice with key ${confirmKey.slice(0, 8)}: booking #${booked.data?.id}, then booking #${again.data?.id}`);
      const page = await adam.as("/bookings?limit=100");
      const count = page.data.items.filter((booking) => booking.hold_id === first.data.id).length;
      log(`Adam has ${plural(count, "booking")} for that hold`);
      return first.data.id === second.data.id && booked.data?.id === again.data?.id && count === 1;
    },
  },
  {
    title: "Sales open on time",
    rule: "Seats can't be held before an event's sale start time.",
    async run({ adam, holdSeats, log, cleanup }) {
      const { data } = await send("/events?limit=100", { token: null, who: "guest" });
      const upcoming = data.items.find((event) => !isOnSale(event));
      if (!upcoming) {
        log("No event has a future sale start right now, so there is nothing to check");
        return null;
      }
      const map = await send(`/events/${upcoming.id}/seatmap`, { token: null, who: "guest" });
      const seat = { id: map.data.sections[0].rows[0].seats[0].id };
      const result = await holdSeats(adam, [seat], undefined, upcoming.id);
      if (result.response.status === 201) {
        cleanup(() => adam.as(`/holds/${result.data.id}`, { method: "DELETE" }));
      }
      log(`Adam tries to hold a seat for ${upcoming.title}, which opens ${when(upcoming.sale_starts_at)}: ${outcome(result)}`);
      return result.response.status === 409 && /not started/.test(result.data?.detail);
    },
  },
  {
    title: "Roles",
    rule: "Only organizers can create events. Attendees can browse, hold and book.",
    async run({ adam, log }) {
      const result = await adam.as("/events", { method: "POST", body: {} });
      log(`Adam, an attendee, tries to create an event: ${outcome(result)}`);
      return result.response.status === 403;
    },
  },
  {
    title: "Holds expire on their own",
    rule: "Every hold ends at a fixed time set by the database clock. After that its seats count as free, with no cleanup job.",
    async run({ adam, holdSeats, seats, log, cleanup }) {
      const [seat] = await seats(1);
      const hold = await holdSeats(adam, [seat]);
      cleanup(() => adam.as(`/holds/${hold.data.id}`, { method: "DELETE" }));
      const seconds = Math.round((new Date(hold.data.expires_at) - new Date(hold.data.created_at)) / 1000);
      log(`Hold #${hold.data.id} on ${seat.label} is ${hold.data.state} and ends ${seconds} seconds after it was made`);
      log("Reads compare that time with the database's now(), so an expired hold frees its seats everywhere at once");
      return hold.data.state === "active" && seconds > 0;
    },
  },
];

async function labSession() {
  if (state.lab && Date.now() - state.lab.at < 10 * 60 * 1000) {
    return state.lab;
  }
  const buyers = await Promise.all(
    DEMO_ACCOUNTS.map(async (account) => {
      const login = await send("/auth/login", {
        method: "POST",
        body: { email: account.email, password: DEMO_PASSWORD },
        token: null,
        who: account.name,
      });
      if (!login.response.ok) {
        throw new Error(`Couldn't sign in as ${account.name}. Run scripts/seed_demo.py to create the demo buyers.`);
      }
      const token = login.data.access_token;
      return { ...account, as: (path, options = {}) => send(path, { ...options, token, who: account.name }) };
    }),
  );
  const { data } = await send("/events?limit=100", { token: null, who: "guest" });
  const arena = data.items.find((event) => event.title === ARENA_TITLE);
  if (!arena) {
    throw new Error(`The ${ARENA_TITLE} event is missing. Run scripts/seed_demo.py to create it.`);
  }
  state.lab = { adam: buyers[0], ben: buyers[1], arena, at: Date.now() };
  return state.lab;
}

async function arenaSeats(arena) {
  const { data } = await send(`/events/${arena.id}/seatmap`, { token: null, who: "guest" });
  return data.sections.flatMap((section) =>
    section.rows.flatMap((row) => row.seats.map((seat) => ({ ...seat, label: `${row.label}${seat.number}` }))),
  );
}

async function runCheck(index) {
  const check = LAB[index];
  const verdict = document.querySelector(`#verdict-${index}`);
  const list = document.querySelector(`#log-${index}`);
  const log = (text, kind = "") => {
    list?.insertAdjacentHTML("beforeend", `<li class="${kind}">${esc(text)}</li>`);
  };
  const cleanups = [];
  list.innerHTML = "";
  verdict.className = "verdict running";
  verdict.textContent = "Running";
  let passed = false;
  try {
    const { adam, ben, arena } = await labSession();
    passed = await check.run({
      adam,
      ben,
      log,
      cleanup: (undo) => cleanups.push(undo),
      holdSeats: (buyer, chosen, key, eventId = arena.id) =>
        buyer.as(`/events/${eventId}/holds`, {
          method: "POST",
          body: { seat_ids: chosen.map((seat) => seat.id) },
          headers: key ? { "Idempotency-Key": key } : {},
        }),
      seats: async (count) => {
        const free = (await arenaSeats(arena)).filter((seat) => seat.status === "available");
        if (free.length < count) {
          throw new Error(`Only ${free.length} free seats left in the arena, try again in a few minutes`);
        }
        return free.sort(() => Math.random() - 0.5).slice(0, count);
      },
      statusOf: async (seat) => (await arenaSeats(arena)).find((each) => each.id === seat.id)?.status,
    });
  } catch (error) {
    log(error.message, "bad");
  } finally {
    for (const undo of cleanups.reverse()) {
      await undo().catch(() => {});
    }
    if (cleanups.length) {
      log("Cleaned up: everything this check held or booked is free again", "muted");
    }
  }
  const label = passed === null ? "Skipped" : passed ? "Passed" : "Failed";
  verdict.className = `verdict ${passed === null ? "skip" : passed ? "pass" : "fail"}`;
  verdict.textContent = label;
  return passed;
}

async function requireAdmin(returnTo) {
  if (!state.token) {
    requireSignIn(returnTo);
    return false;
  }
  state.user ??= await api("/auth/me").catch(() => null);
  if (state.user?.role === "admin") {
    return true;
  }
  location.hash = "#/";
  return false;
}

async function renderLab() {
  if (!(await requireAdmin("#/lab"))) {
    return;
  }
  view.innerHTML = `
    <div class="page-head lab-head">
      <div>
        <span class="kicker">Rules lab</span>
        <h1>Watch the backend enforce its rules</h1>
        <p class="lead">Each check signs in as Adam and Ben, sends real requests to the live API on the
        ${ARENA_TITLE} event and checks the answers. Anything it holds or books is released afterwards.
        Open the request log to see every call.</p>
      </div>
      <button id="run-all">Run all checks <span class="arrow">&rarr;</span></button>
    </div>
    <div class="lab">
      ${LAB.map(
        (check, index) => `
          <article class="check" style="--i:${index}">
            <div class="check-head">
              <span class="check-number">${String(index + 1).padStart(2, "0")}</span>
              <div><h3>${check.title}</h3><p class="muted">${check.rule}</p></div>
              <span class="verdict" id="verdict-${index}">Not run</span>
              <button class="secondary small" data-run="${index}">Run</button>
            </div>
            <ol class="check-log" id="log-${index}"></ol>
          </article>`,
      ).join("")}
    </div>`;
  const buttons = () => view.querySelectorAll("#run-all, [data-run]");
  const busy = async (work) => {
    buttons().forEach((button) => (button.disabled = true));
    try {
      await work();
    } finally {
      buttons().forEach((button) => (button.disabled = false));
    }
  };
  view.onclick = (click) => {
    const index = click.target.closest("[data-run]")?.dataset.run;
    if (index !== undefined) {
      busy(() => runCheck(Number(index)));
    }
    if (click.target.closest("#run-all")) {
      busy(async () => {
        for (const index of LAB.keys()) {
          await runCheck(index);
        }
      });
    }
  };
}

const TOUR = [
  ["signin", "Sign in as Adam or Ben", "#/login"],
  ["hold", "Hold seats and watch the timer", "#/"],
  ["book", "Confirm a booking", null],
  ["cancel", "Cancel it in My bookings", "#/bookings"],
  ["live", "See the other buyer's change arrive live", null, "Sign in as the other buyer in a private window and hold a seat on the same event."],
  ["log", "Open the request log", null],
];

function loadTour() {
  try {
    return new Set(JSON.parse(localStorage.getItem("tour") ?? "[]"));
  } catch {
    return new Set();
  }
}

const tourDone = loadTour();
const tourPanel = document.querySelector("#tour");
const logPanel = document.querySelector("#log");
const openRequests = new Set();

function saveTour() {
  try {
    localStorage.setItem("tour", JSON.stringify([...tourDone]));
  } catch {}
}

function tick(step) {
  if (tourDone.has(step)) {
    return;
  }
  tourDone.add(step);
  saveTour();
  drawTour();
}

function drawTour() {
  document.querySelector("#tour-count").textContent = `${TOUR.filter(([step]) => tourDone.has(step)).length}/${TOUR.length}`;
  tourPanel.innerHTML = `
    <div class="drawer-head">
      <strong>5-minute tour</strong>
      <button class="link" id="tour-reset">Start over</button>
    </div>
    <p class="muted">Everything runs against the live API. Steps tick themselves off as you go.</p>
    <ol class="tour-steps">
      ${TOUR.map(
        ([step, text, link, hint]) => `
          <li class="${tourDone.has(step) ? "done" : ""}">
            <span class="check-mark"></span>
            <span>${link ? `<a href="${link}">${text}</a>` : text}${hint ? `<small>${hint}</small>` : ""}</span>
          </li>`,
      ).join("")}
    </ol>`;
}

const statusTone = (status) => (status < 300 ? "ok" : status < 500 ? "warn" : "bad");

const preview = (value) => {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text;
};

function record(entry) {
  state.sent += 1;
  state.requests.unshift({ ...entry, id: state.sent });
  state.requests.length = Math.min(state.requests.length, LOG_LIMIT);
  document.querySelector("#log-count").textContent = state.sent;
  if (!logPanel.hidden) {
    drawLog();
  }
}

function drawLog() {
  logPanel.innerHTML = `
    <div class="drawer-head">
      <strong>Request log</strong>
      <button class="link" id="log-clear">Clear</button>
    </div>
    <p class="muted">Every call this page made to the API, newest first. Passwords and tokens are hidden.</p>
    <ol class="requests">
      ${
        state.requests
          .map(
            (entry) => `
              <li>
                <details data-request="${entry.id}" ${openRequests.has(entry.id) ? "open" : ""}>
                  <summary>
                    <span class="method">${entry.method}</span>
                    <span class="path">${esc(entry.path)}</span>
                    <span class="status ${statusTone(entry.status)}">${entry.status}</span>
                    <span class="muted">${entry.ms} ms · ${esc(entry.who)}</span>
                  </summary>
                  ${entry.key ? `<p class="muted">Idempotency-Key <code>${esc(entry.key)}</code></p>` : ""}
                  ${entry.sent ? `<pre>${esc(preview(entry.sent))}</pre>` : ""}
                  ${entry.received ? `<pre>${esc(preview(entry.received))}</pre>` : ""}
                  ${entry.replay ? `<button class="secondary small" data-replay="${entry.id}">Send again with the same key</button>` : ""}
                </details>
              </li>`,
          )
          .join("") || `<li class="muted">Nothing yet. Click around and the calls show up here.</li>`
      }
    </ol>`;
}

function togglePanel(panel, draw) {
  const opening = panel.hidden;
  tourPanel.hidden = true;
  logPanel.hidden = true;
  panel.hidden = !opening;
  if (opening) {
    draw();
  }
}

document.querySelector("#tour-toggle").onclick = () => togglePanel(tourPanel, drawTour);
document.querySelector("#log-toggle").onclick = () => {
  togglePanel(logPanel, drawLog);
  tick("log");
};

tourPanel.onclick = (click) => {
  if (click.target.closest("#tour-reset")) {
    tourDone.clear();
    saveTour();
    drawTour();
  }
};

logPanel.addEventListener(
  "toggle",
  (toggle) => {
    const id = Number(toggle.target.dataset.request);
    if (toggle.target.open) {
      openRequests.add(id);
    } else {
      openRequests.delete(id);
    }
  },
  true,
);

logPanel.onclick = (click) => {
  if (click.target.closest("#log-clear")) {
    state.requests = [];
    drawLog();
    return;
  }
  const id = Number(click.target.closest("[data-replay]")?.dataset.replay);
  const entry = state.requests.find((each) => each.id === id);
  if (!entry) {
    return;
  }
  attempt(async () => {
    const { response, data } = await send(entry.path, entry.replay);
    const same = data?.id !== undefined && data.id === entry.received?.id;
    toast(
      same
        ? `Same key, same answer: #${data.id} came back and nothing new was created.`
        : `Sent again: ${response.status}${data?.detail ? ` ${describe(data.detail)}` : ""}`,
      same ? "ok" : "info",
    );
  });
};

const CATEGORIES = ["concert", "sports", "theatre", "conference", "festival"];

const rowLabel = (index) =>
  (index >= 26 ? rowLabel(Math.floor(index / 26) - 1) : "") + String.fromCharCode(65 + (index % 26));

const localInput = (date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const tierFields = ({ name = "", price = "", rows = 2, seats = 10 } = {}) => `
  <div class="tier">
    <label>Tier<input name="tier" value="${esc(name)}" maxlength="50" required></label>
    <label>Price (₹)<input name="price" type="number" min="1" value="${price}" required></label>
    <label>Rows<input name="rows" type="number" min="1" max="100" value="${rows}" required></label>
    <label>Seats a row<input name="seats" type="number" min="1" max="200" value="${seats}" required></label>
    <button type="button" class="secondary small" data-remove-tier aria-label="Remove tier">&times;</button>
  </div>`;

function eventPayload(form) {
  const data = new FormData(form);
  const prices = data.getAll("price");
  const rows = data.getAll("rows");
  const seats = data.getAll("seats");
  const tiers = data.getAll("tier").map((name, index) => ({
    name: name.trim(),
    price_cents: Math.round(Number(prices[index]) * 100),
    rows: Number(rows[index]),
    seats: Number(seats[index]),
  }));
  let row = 0;
  return {
    title: data.get("title").trim(),
    description: data.get("description").trim(),
    category: data.get("category"),
    city: data.get("city").trim(),
    venue: data.get("venue").trim(),
    starts_at: new Date(data.get("starts_at")).toISOString(),
    sale_starts_at: new Date(data.get("sale_starts_at")).toISOString(),
    price_tiers: tiers.map(({ name, price_cents }) => ({ name, price_cents })),
    sections: [
      {
        name: "Main floor",
        rows: tiers.flatMap((tier) =>
          Array.from({ length: tier.rows }, () => ({
            label: rowLabel(row++),
            seat_count: tier.seats,
            price_tier: tier.name,
          })),
        ),
      },
    ],
  };
}

async function renderManage() {
  if (!(await requireAdmin("#/manage"))) {
    return;
  }
  const mine = await api("/events/mine?limit=100");
  const sales = new Map(
    await Promise.all(
      mine.items
        .filter((event) => event.status === "published")
        .map(async (event) => [event.id, await api(`/events/${event.id}/sales`)]),
    ),
  );
  const starts = new Date(Date.now() + 30 * 86400000);
  starts.setHours(19, 0, 0, 0);
  view.innerHTML = `
    <div class="page-head">
      <div><span class="kicker">Admin</span><h1>Your events</h1></div>
      <span class="muted">${plural(mine.items.length, "event")}</span>
    </div>
    <div class="manage">
      <form class="panel stack" id="new-event">
        <h2>New event</h2>
        <label>Title<input name="title" maxlength="200" required></label>
        <label>Description<textarea name="description" rows="3" maxlength="5000"></textarea></label>
        <div class="fields">
          <label>Category<select name="category">${CATEGORIES.map((category) => `<option>${category}</option>`).join("")}</select></label>
          <label>City<input name="city" maxlength="100" required></label>
        </div>
        <label>Venue<input name="venue" maxlength="200" required></label>
        <div class="fields">
          <label>Starts<input name="starts_at" type="datetime-local" value="${localInput(starts)}" required></label>
          <label>Sale opens<input name="sale_starts_at" type="datetime-local" value="${localInput(new Date())}" required></label>
        </div>
        <div class="tiers">
          ${tierFields({ name: "Front", price: 2499, rows: 2 })}
          ${tierFields({ name: "Back", price: 999, rows: 3 })}
        </div>
        <div class="tiers-foot">
          <button type="button" class="secondary small" id="add-tier">Add tier</button>
          <span class="muted" id="seat-total"></span>
        </div>
        <div class="actions">
          <button type="submit" name="publish">Create and publish</button>
          <button type="submit" class="secondary">Save as draft</button>
        </div>
      </form>
      <div class="list">
        ${
          mine.items.length
            ? mine.items
                .map((event, index) => {
                  const sold = sales.get(event.id);
                  return `
                    <div class="ticket booking tone-${tone(event.category)}" style="--i:${index}">
                      <div class="booking-main">
                        <div>
                          ${
                            sold
                              ? `<a href="#/events/${event.id}"><strong>${esc(event.title)}</strong></a>`
                              : `<strong>${esc(event.title)}</strong>`
                          }
                          <p class="muted">${when(event.starts_at)} &middot; ${esc(event.city)}</p>
                          <p class="muted">${
                            sold
                              ? `${sold.seats_booked} of ${sold.seats_total} seats booked &middot; ${money(sold.gross_cents)}`
                              : `Draft. Sale opens ${when(event.sale_starts_at)}`
                          }</p>
                        </div>
                      </div>
                      <div class="booking-stub">
                        ${
                          sold
                            ? `<span class="badge live">Live</span>`
                            : `<button class="small" data-publish="${event.id}">Publish</button>`
                        }
                      </div>
                    </div>`;
                })
                .join("")
            : `<p class="empty">No events yet. Create one and it shows up here.</p>`
        }
      </div>
    </div>`;
  const form = document.querySelector("#new-event");
  const tiers = form.querySelector(".tiers");
  const countSeats = () => {
    const rows = form.querySelectorAll("[name=rows]");
    const seats = [...form.querySelectorAll("[name=seats]")];
    const total = [...rows].reduce((sum, input, index) => sum + Number(input.value) * Number(seats[index].value), 0);
    form.querySelector("#seat-total").textContent = `${plural(total, "seat")} in ${plural(
      [...rows].reduce((sum, input) => sum + Number(input.value), 0),
      "row",
    )}`;
  };
  countSeats();
  form.oninput = countSeats;
  form.querySelector("#add-tier").onclick = () => {
    tiers.insertAdjacentHTML("beforeend", tierFields());
    countSeats();
  };
  tiers.onclick = (click) => {
    const tier = click.target.closest("[data-remove-tier]")?.closest(".tier");
    if (tier && tiers.children.length > 1) {
      tier.remove();
      countSeats();
    }
  };
  form.onsubmit = (submit) => {
    submit.preventDefault();
    const publish = submit.submitter?.name === "publish";
    attempt(async () => {
      const event = await api("/events", { method: "POST", body: eventPayload(form) });
      if (publish) {
        await api(`/events/${event.id}/publish`, { method: "POST" });
      }
      toast(publish ? `${event.title} is on sale.` : `${event.title} saved as a draft.`, "ok");
      await renderManage();
    });
  };
  view.onclick = (click) => {
    const eventId = click.target.closest("[data-publish]")?.dataset.publish;
    if (eventId) {
      attempt(async () => {
        await api(`/events/${eventId}/publish`, { method: "POST" });
        toast("Published. It's on the home page now.", "ok");
        await renderManage();
      });
    }
  };
}

const ROUTES = [
  [/^#\/$/, renderEvents],
  [/^#\/events\/(\d+)$/, renderEvent],
  [/^#\/bookings$/, renderBookings],
  [/^#\/manage$/, renderManage],
  [/^#\/lab$/, renderLab],
  [/^#\/login$/, renderLogin],
];

function route() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  const socket = state.socket;
  state.socket = null;
  socket?.close();
  view.onclick = null;
  window.scrollTo(0, 0);
  const hash = location.hash || "#/";
  const section = navSection(hash === "#/login" && state.returnTo !== "#/" ? state.returnTo : hash);
  for (const link of nav.querySelectorAll("a")) {
    link.toggleAttribute("aria-current", link.getAttribute("href") === section);
  }
  movePill(currentLink());
  for (const [pattern, render] of ROUTES) {
    const match = hash.match(pattern);
    if (match) {
      render(...match.slice(1)).catch((error) => {
        view.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
      });
      return;
    }
  }
  location.hash = "#/";
}

let lastMove = null;

function followPointer() {
  const move = lastMove;
  lastMove = null;
  const card = move.target.closest?.(".spotlight, .tilt");
  if (!card) {
    return;
  }
  const box = card.getBoundingClientRect();
  const x = move.clientX - box.left;
  const y = move.clientY - box.top;
  card.style.setProperty("--x", `${x}px`);
  card.style.setProperty("--y", `${y}px`);
  card.style.setProperty("--rx", `${(0.5 - y / box.height) * 10}deg`);
  card.style.setProperty("--ry", `${(x / box.width - 0.5) * 14}deg`);
}

document.addEventListener("pointermove", (move) => {
  if (!lastMove) {
    requestAnimationFrame(followPointer);
  }
  lastMove = move;
});

let scrollEnd = null;
window.addEventListener(
  "scroll",
  () => {
    document.body.classList.add("scrolling");
    clearTimeout(scrollEnd);
    scrollEnd = setTimeout(() => document.body.classList.remove("scrolling"), 150);
  },
  { passive: true },
);

const nav = document.querySelector("nav");
const pill = nav.querySelector(".pill");
const currentLink = () => nav.querySelector("a[aria-current]");

function navSection(hash) {
  if (["#/bookings", "#/manage", "#/lab"].includes(hash)) {
    return hash;
  }
  return hash === "#/" || hash.startsWith("#/events") ? "#/" : null;
}

function movePill(link) {
  pill.style.opacity = link ? "1" : "0";
  if (link) {
    pill.style.width = `${link.offsetWidth}px`;
    pill.style.transform = `translateX(${link.offsetLeft}px)`;
  }
}

nav.onpointerover = (over) => {
  const link = over.target.closest("a");
  if (link) {
    movePill(link);
  }
};
nav.onpointerleave = () => movePill(currentLink());
document.fonts.ready.then(() => movePill(currentLink()));
window.addEventListener("resize", () => movePill(currentLink()));

window.addEventListener("hashchange", route);
drawTour();
renderNav();
route();
