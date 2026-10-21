const DEMO_ACCOUNT = { email: "demo@example.com", password: "demo-password" };
const REFRESH_MS = 4000;
const TONES = 4;

const state = {
  token: localStorage.getItem("token"),
  user: null,
  holds: new Map(),
  timers: [],
  socket: null,
  returnTo: "#/",
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

const when = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

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

async function api(path, options = {}, retried = false) {
  const { method = "GET", body, headers = {} } = options;
  const response = await fetch(path, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(state.token && { Authorization: `Bearer ${state.token}` }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  if (response.status === 401 && state.token) {
    if (!retried && (await refreshSession())) {
      return api(path, options, true);
    }
    signOut();
    toast("Your session ended. Please sign in again.", "info");
  }
  if (response.status === 204) {
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(describe(data.detail) || `Request failed with status ${response.status}`);
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
    auth.innerHTML = `<a class="button small" href="#/login">Sign in</a>`;
    return;
  }
  state.user ??= await api("/auth/me").catch(() => null);
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

async function signIn(email, password) {
  const tokens = await api("/auth/login", { method: "POST", body: { email, password } });
  state.token = tokens.access_token;
  state.user = null;
  localStorage.setItem("token", state.token);
  localStorage.setItem("refresh_token", tokens.refresh_token);
  if (email === DEMO_ACCOUNT.email) {
    await cancelAllBookings();
  }
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
  ["Confirm", "Book before the five-minute timer runs out, or the seats go back on sale."],
];

async function renderEvents() {
  view.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow"><i class="pulse"></i>Live seat map over WebSockets</span>
        <h1>Grab the seat <mark>before anyone else</mark> does.</h1>
        <p class="lead">Hundreds of buyers, a handful of seats, and a database that never sells
        the same seat twice. Hold your seats for five minutes and confirm before the timer runs out.</p>
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
      <div><span class="kicker">How it works</span><h2>Three steps, five minutes</h2></div>
    </div>
    <ol class="steps">
      ${STEPS.map(
        ([title, text], index) => `
          <li class="tone-${index}" style="--i:${index}">
            <small>0${index + 1}</small><strong>${title}</strong><span>${text}</span>
          </li>`,
      ).join("")}
    </ol>`;
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
      attempt(async () => {
        try {
          booking = await api(`/holds/${hold.id}/confirm`, {
            method: "POST",
            headers: { "Idempotency-Key": hold.confirmKey },
          });
          state.holds.delete(event.id);
          toast("Booking confirmed.", "ok");
        } finally {
          await refresh();
        }
      });
    };
    document.querySelector("#release").onclick = () =>
      attempt(async () => {
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
        <p class="lead">Hold seats, confirm bookings and cancel them. Use the shared demo account,
        or create your own in one step.</p>
      </div>
      <div class="panel spotlight">
        <div class="demo">
          <span class="kicker">Demo pass</span>
          <p><code>${DEMO_ACCOUNT.email}</code><code>${DEMO_ACCOUNT.password}</code></p>
          <p class="muted">Anyone can use it. Its bookings are cancelled on every sign-in, so you always start clean.</p>
          <button id="demo">Sign in as the demo user <span class="arrow">&rarr;</span></button>
        </div>
        <div class="divider">or use your own account</div>
        <form id="login" class="stack">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
          <button type="submit">Sign in</button>
          <button type="button" class="secondary" id="register">Create account</button>
        </form>
      </div>
    </section>`;
  const form = document.querySelector("#login");
  const credentials = () => Object.fromEntries(new FormData(form));
  form.onsubmit = (submit) => {
    submit.preventDefault();
    const { email, password } = credentials();
    attempt(() => signIn(email, password));
  };
  document.querySelector("#register").onclick = () => {
    if (!form.reportValidity()) {
      return;
    }
    const { email, password } = credentials();
    attempt(async () => {
      await api("/auth/register", { method: "POST", body: { email, password } });
      await signIn(email, password);
    });
  };
  document.querySelector("#demo").onclick = () =>
    attempt(() => signIn(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password));
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
      toast("Booking cancelled. The seats are available again.", "ok");
      await renderBookings();
    });
  };
}

const ROUTES = [
  [/^#\/$/, renderEvents],
  [/^#\/events\/(\d+)$/, renderEvent],
  [/^#\/bookings$/, renderBookings],
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
  if (hash === "#/bookings") {
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
renderNav();
route();
