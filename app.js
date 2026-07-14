/* ============================================================
   evensplit — client-side shared-bill splitter.
   No network. No dependencies. State in localStorage only.

   Money is handled in integer minor units ("cents") throughout
   to avoid binary floating-point drift, then formatted for display.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny DOM helpers ---------- */
  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- money: work in integer cents ---------- */
  // Parse a user string ("1,240.50", "  99 ") to integer cents, or null if invalid.
  function parseCents(str) {
    if (str == null) return null;
    var s = String(str).replace(/[,\s]/g, "").replace(/[^0-9.]/g, "");
    if (s === "" || s === ".") return null;
    var v = parseFloat(s);
    if (isNaN(v) || v < 0) return null;
    return Math.round(v * 100);
  }
  // Format integer cents as a grouped decimal string (no symbol): 124050 -> "1,240.50".
  function fmtCents(cents) {
    var neg = cents < 0;
    var abs = Math.abs(cents);
    var whole = Math.floor(abs / 100);
    var frac = abs % 100;
    var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + w + "." + (frac < 10 ? "0" + frac : frac);
  }
  function money(cents) { return state.currency + fmtCents(cents); }

  /* ============================================================
     LARGEST-REMAINDER SPLIT
     Split `total` cents across weights[] so the parts are integers
     that sum to EXACTLY total. Floor each ideal share, then hand the
     leftover cents one-by-one to the entries with the largest
     fractional remainders (ties broken by original index). This is
     the standard largest-remainder / Hamilton apportionment method,
     so no cent is ever lost or invented by rounding.
     ============================================================ */
  function splitByWeights(total, weights) {
    var n = weights.length;
    var out = new Array(n).fill(0);
    var sumW = weights.reduce(function (a, b) { return a + b; }, 0);
    if (n === 0 || sumW <= 0) return out;

    var remainders = [];
    var assigned = 0;
    for (var i = 0; i < n; i++) {
      var ideal = total * weights[i] / sumW;      // exact rational share (may be fractional)
      var floor = Math.floor(ideal);
      out[i] = floor;
      assigned += floor;
      remainders.push({ i: i, frac: ideal - floor });
    }
    var leftover = total - assigned;               // cents still to distribute (0..n-1)
    // Give leftover cents to the largest fractional remainders first.
    remainders.sort(function (a, b) {
      if (b.frac !== a.frac) return b.frac - a.frac;
      return a.i - b.i;                            // stable tie-break
    });
    for (var k = 0; k < leftover; k++) out[remainders[k].i]++;
    return out;
  }

  /* ============================================================
     COMPUTE PER-PERSON OWED for one expense.
     Returns a map personId -> owed cents, summing to expense.amount.
     Methods: equal (among participants), shares (weights),
     exact (explicit cents per person, must already reconcile).
     ============================================================ */
  function owedForExpense(exp) {
    var owed = {};
    if (exp.method === "exact") {
      // exact amounts are stored per person already, in cents
      Object.keys(exp.exact).forEach(function (pid) { owed[pid] = exp.exact[pid]; });
      return owed;
    }
    var ids = exp.participants.slice();
    if (!ids.length) return owed;
    var weights;
    if (exp.method === "shares") {
      weights = ids.map(function (pid) { return exp.shares[pid] || 0; });
    } else {
      weights = ids.map(function () { return 1; });   // equal
    }
    var parts = splitByWeights(exp.amount, weights);
    ids.forEach(function (pid, idx) { owed[pid] = parts[idx]; });
    return owed;
  }

  /* ============================================================
     BALANCES: for the active group, net = paid - owed, in cents.
     Includes former (removed) members if they still have history.
     ============================================================ */
  function computeBalances(group) {
    var paid = {}, owed = {};
    group.people.forEach(function (p) { paid[p.id] = 0; owed[p.id] = 0; });

    group.expenses.forEach(function (exp) {
      if (paid[exp.payer] == null) paid[exp.payer] = 0;   // defensive (former member)
      paid[exp.payer] += exp.amount;
      var share = owedForExpense(exp);
      Object.keys(share).forEach(function (pid) {
        if (owed[pid] == null) owed[pid] = 0;
        owed[pid] += share[pid];
      });
    });

    var net = {};
    Object.keys(paid).forEach(function (pid) {
      net[pid] = (paid[pid] || 0) - (owed[pid] || 0);
    });
    return { paid: paid, owed: owed, net: net };
  }

  /* ============================================================
     SETTLEMENT — minimum-cash-flow greedy.

     Given each person's net balance (creditors > 0, debtors < 0,
     summing to ~0), produce the fewest transfers that clear everyone.

     Repeatedly take the biggest creditor and the biggest debtor and
     settle min(|debtor|, creditor) between them. Each pass zeroes out
     at least one of the two, so the number of transfers is bounded by
     (people - 1) and is minimal for typical inputs. Because we settle
     the largest amounts first, no chains of tiny payments are created.
     ============================================================ */
  function settle(net) {
    var creditors = [];  // { id, amt>0 }  owed money
    var debtors   = [];  // { id, amt>0 }  owe money (stored positive)
    Object.keys(net).forEach(function (id) {
      var v = net[id];
      if (v > 0) creditors.push({ id: id, amt: v });
      else if (v < 0) debtors.push({ id: id, amt: -v });
    });
    // Sort largest-first so the biggest imbalances are cleared first.
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    debtors.sort(function (a, b) { return b.amt - a.amt; });

    var transfers = [];
    var ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      var c = creditors[ci], d = debtors[di];
      var pay = Math.min(c.amt, d.amt);     // integer cents
      if (pay > 0) transfers.push({ from: d.id, to: c.id, amt: pay });
      c.amt -= pay;
      d.amt -= pay;
      // Whichever side hit zero advances; re-sorting isn't needed because
      // we always drain the current largest pair fully before moving on.
      if (c.amt === 0) ci++;
      if (d.amt === 0) di++;
    }
    return transfers;
  }

  /* ============================================================
     STATE + PERSISTENCE (localStorage only)
     ============================================================ */
  var STORE_KEY = "evensplit:v1";
  var storageOk = true;

  var state = {
    currency: "₹",      // ₹
    activeId: null,
    groups: []               // [{ id, name, people:[{id,name,active}], expenses:[...] }]
  };

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; }
  }

  function load() {
    try {
      localStorage.setItem("evensplit:test", "1");
      localStorage.removeItem("evensplit:test");
    } catch (e) { storageOk = false; }

    var raw = null;
    if (storageOk) { try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; } }
    if (raw) {
      try {
        var loaded = JSON.parse(raw);
        if (loaded && Array.isArray(loaded.groups)) {
          state = loaded;
          if (typeof state.currency !== "string" || !state.currency) state.currency = "₹";
        }
      } catch (e) { /* fall through to seed */ }
    }
    if (!state.groups.length) seed();
    if (!state.activeId || !groupById(state.activeId)) state.activeId = state.groups[0].id;
  }

  // A friendly first-run house so the app is never a blank slate.
  function seed() {
    var a = uid(), b = uid(), c = uid();
    var g = {
      id: uid(),
      name: "My flat",
      people: [
        { id: a, name: "You", active: true },
        { id: b, name: "Sam", active: true },
        { id: c, name: "Jo",  active: true }
      ],
      expenses: [
        { id: uid(), desc: "Groceries", amount: 3600, payer: a, method: "equal",
          participants: [a, b, c], shares: {}, exact: {} },
        { id: uid(), desc: "Wifi",      amount: 1500, payer: b, method: "equal",
          participants: [a, b, c], shares: {}, exact: {} }
      ]
    };
    state.groups = [g];
    state.activeId = g.id;
  }

  function groupById(id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return null;
  }
  function activeGroup() { return groupById(state.activeId); }
  function personById(g, id) {
    for (var i = 0; i < g.people.length; i++) if (g.people[i].id === id) return g.people[i];
    return null;
  }
  function personName(g, id) { var p = personById(g, id); return p ? p.name : "(removed)"; }
  function activePeople(g) { return g.people.filter(function (p) { return p.active !== false; }); }

  // deterministic colour dot per person id (stable, no storage)
  function dotColor(id) {
    var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    var palette = ["#2FA37C", "#D98A5A", "#4E7CA8", "#B06AA8", "#C7973E", "#5CA37B", "#C1503E", "#6E8AA0"];
    return palette[h % palette.length];
  }

  /* ============================================================
     FORM: split-method UI state (which method, current inputs)
     ============================================================ */
  var editingId = null;   // expense id being edited, or null for "add new"

  function currentMethod() {
    var r = $("input[name=splitmethod]:checked");
    return r ? r.value : "equal";
  }
  function selectedParticipants() {
    return $$("#participants .part__check input:checked").map(function (cb) { return cb.value; });
  }

  /* ============================================================
     RENDER — group bar / selects
     ============================================================ */
  function renderGroupSelect() {
    var sel = $("#groupSelect");
    sel.innerHTML = "";
    state.groups.forEach(function (g) {
      var o = el("option", null, g.name);
      o.value = g.id;
      if (g.id === state.activeId) o.selected = true;
      sel.appendChild(o);
    });
    $("#deleteGroupBtn").disabled = state.groups.length <= 1;
  }

  function renderPayerSelect() {
    var g = activeGroup();
    var sel = $("#expPayer");
    var prev = sel.value;
    sel.innerHTML = "";
    var people = activePeople(g);
    if (!people.length) {
      var o = el("option", null, "Add a housemate first");
      o.value = ""; o.disabled = true; o.selected = true;
      sel.appendChild(o);
      return;
    }
    people.forEach(function (p) {
      var opt = el("option", null, p.name);
      opt.value = p.id;
      sel.appendChild(opt);
    });
    if (prev && personById(g, prev) && personById(g, prev).active !== false) sel.value = prev;
  }

  /* ============================================================
     RENDER — people chips
     ============================================================ */
  function renderPeople() {
    var g = activeGroup();
    var list = $("#peopleList");
    list.innerHTML = "";
    g.people.forEach(function (p) {
      var li = el("li", "person" + (p.active === false ? " person--gone" : ""));
      var dot = el("span", "person__dot"); dot.style.backgroundColor = dotColor(p.id);
      li.appendChild(dot);

      var name = el("input", "person__name");
      name.value = p.name;
      name.setAttribute("aria-label", "Rename " + p.name);
      name.maxLength = 40;
      if (p.active === false) name.disabled = true;
      name.addEventListener("change", function () {
        var v = name.value.trim();
        if (v) { p.name = v; save(); renderAll(); }
        else { name.value = p.name; }
      });
      name.addEventListener("keydown", function (e) { if (e.key === "Enter") name.blur(); });
      li.appendChild(name);

      var x = el("button", "person__x");
      x.type = "button";
      x.setAttribute("aria-label", "Remove " + p.name);
      x.textContent = "×";
      x.addEventListener("click", function () { removePerson(p.id); });
      li.appendChild(x);

      list.appendChild(li);
    });
    $("#peopleCount").textContent = String(activePeople(g).length);
    $("#peopleHint").textContent = activePeople(g).length < 2
      ? "Add everyone who shares bills. You need at least two people to split anything."
      : "Click a name to rename. Removing someone keeps their past expenses for the record.";
  }

  // Removing a person: if they have any history (paid or in a split), keep
  // them as an inactive "former member" so balances still reconcile.
  function removePerson(id) {
    var g = activeGroup();
    var hasHistory = g.expenses.some(function (exp) {
      if (exp.payer === id) return true;
      if (exp.participants && exp.participants.indexOf(id) !== -1) return true;
      if (exp.exact && exp.exact[id] != null) return true;
      return false;
    });
    var p = personById(g, id);
    if (!p) return;
    if (hasHistory) {
      p.active = false;   // soft-remove: preserve the ledger
    } else {
      g.people = g.people.filter(function (q) { return q.id !== id; });
    }
    // if the removed person was the selected payer / editing, refresh form
    if (editingId) cancelEdit();
    save();
    renderAll();
  }

  /* ============================================================
     RENDER — participants block inside the expense form
     ============================================================ */
  function renderParticipants() {
    var g = activeGroup();
    var wrap = $("#participants");
    var method = currentMethod();

    // remember prior checks / values so switching methods doesn't wipe input
    var priorChecked = {};
    $$("#participants .part__check input").forEach(function (cb) { priorChecked[cb.value] = cb.checked; });
    var priorVals = {};
    $$("#participants .part__input").forEach(function (inp) { priorVals[inp.dataset.pid] = inp.value; });

    wrap.innerHTML = "";
    var people = activePeople(g);

    $("#splitHint").textContent =
      method === "equal"  ? "Split evenly among everyone you tick below." :
      method === "shares" ? "Give each person a weight (e.g. room size, or 2:1:1). Bigger weight = bigger share." :
                            "Type the exact amount each person owes. They must add up to the total.";

    people.forEach(function (p) {
      var checkedBefore = priorChecked.hasOwnProperty(p.id) ? priorChecked[p.id] : true;
      var row = el("div", "part" + (checkedBefore ? "" : " part--off"));

      // checkbox (who is in the split)
      var chk = el("label", "part__check");
      var cb = el("input"); cb.type = "checkbox"; cb.value = p.id; cb.checked = checkedBefore;
      cb.setAttribute("aria-label", "Include " + p.name);
      cb.addEventListener("change", function () {
        row.classList.toggle("part--off", !cb.checked);
        var inp = $(".part__input", row);
        if (inp) inp.disabled = !cb.checked;
        updateReconcile();
      });
      chk.appendChild(cb);
      row.appendChild(chk);

      var nm = el("span", "part__name", p.name);
      row.appendChild(nm);

      // right side depends on method
      if (method === "equal") {
        var comp = el("span", "part__computed");
        comp.dataset.pid = p.id;
        row.appendChild(comp);
      } else {
        var box = el("span", "part__value");
        var inp = el("input", "part__input");
        inp.type = "text";
        inp.inputMode = "decimal";
        inp.dataset.pid = p.id;
        inp.disabled = !checkedBefore;
        inp.value = priorVals[p.id] || "";
        inp.placeholder = method === "shares" ? "1" : "0.00";
        inp.setAttribute("aria-label", (method === "shares" ? "Weight for " : "Exact amount for ") + p.name);
        inp.addEventListener("input", updateReconcile);
        box.appendChild(inp);
        row.appendChild(box);
      }
      wrap.appendChild(row);
    });

    updateReconcile();
  }

  // Live reconciliation readout + equal-share preview.
  function updateReconcile() {
    var method = currentMethod();
    var out = $("#reconcile");
    var totalCents = parseCents($("#expAmount").value);
    var chosen = selectedParticipants();

    if (method === "equal") {
      out.className = "split__reconcile";
      out.textContent = "";
      // preview equal shares live
      if (totalCents != null && chosen.length) {
        var parts = splitByWeights(totalCents, chosen.map(function () { return 1; }));
        var map = {}; chosen.forEach(function (id, i) { map[id] = parts[i]; });
        $$("#participants .part__computed").forEach(function (c) {
          var pid = c.dataset.pid;
          c.textContent = map[pid] != null ? money(map[pid]) : "—";
        });
      } else {
        $$("#participants .part__computed").forEach(function (c) { c.textContent = "—"; });
      }
      return;
    }

    if (method === "shares") {
      var wsum = 0;
      $$("#participants .part__input").forEach(function (inp) {
        if (inp.disabled) return;
        var v = parseFloat((inp.value || "").replace(/[^0-9.]/g, ""));
        if (!isNaN(v) && v > 0) wsum += v;
      });
      out.className = "split__reconcile is-ok";
      if (!chosen.length) { out.className = "split__reconcile is-off"; out.textContent = "Tick at least one person to share this."; }
      else if (wsum <= 0) { out.className = "split__reconcile is-off"; out.textContent = "Give at least one person a positive weight."; }
      else if (totalCents == null) { out.className = "split__reconcile"; out.textContent = "Enter an amount to preview each share."; }
      else { out.textContent = "Weights total " + wsum + " — shares will reconcile to " + money(totalCents) + " exactly."; }
      return;
    }

    // exact
    var sum = 0, any = false, bad = false;
    $$("#participants .part__input").forEach(function (inp) {
      if (inp.disabled) return;
      if ((inp.value || "").trim() === "") return;
      var c = parseCents(inp.value);
      if (c == null) { bad = true; return; }
      sum += c; any = true;
    });
    if (totalCents == null) { out.className = "split__reconcile"; out.textContent = "Enter the total amount above first."; return; }
    var diff = totalCents - sum;
    if (bad) { out.className = "split__reconcile is-off"; out.textContent = "Some amounts aren't valid numbers."; }
    else if (!any) { out.className = "split__reconcile is-off"; out.textContent = "Type each person's exact amount."; }
    else if (diff === 0) { out.className = "split__reconcile is-ok"; out.textContent = "Balanced ✓  " + money(sum) + " of " + money(totalCents) + "."; }
    else if (diff > 0) { out.className = "split__reconcile is-off"; out.textContent = money(diff) + " short of " + money(totalCents) + " — assign the rest."; }
    else { out.className = "split__reconcile is-off"; out.textContent = money(-diff) + " over " + money(totalCents) + " — trim it back."; }
  }

  /* ============================================================
     RENDER — balances table
     ============================================================ */
  function renderBalances() {
    var g = activeGroup();
    var body = $("#balancesBody");
    body.innerHTML = "";
    var b = computeBalances(g);

    // show anyone with activity or who is an active member
    var ids = g.people.filter(function (p) {
      return p.active !== false || (b.paid[p.id] || b.owed[p.id]);
    }).map(function (p) { return p.id; });

    if (!g.expenses.length) {
      $("#balancesEmpty").hidden = false;
      $("#balancesTable").hidden = true;
      return;
    }
    $("#balancesEmpty").hidden = true;
    $("#balancesTable").hidden = false;

    ids.forEach(function (id) {
      var p = personById(g, id);
      var tr = el("tr");

      var nameTd = el("td", "bal-name" + (p && p.active === false ? " bal-name--gone" : ""));
      var dot = el("span", "bal-name__dot"); dot.style.backgroundColor = dotColor(id);
      nameTd.appendChild(dot);
      nameTd.appendChild(document.createTextNode(personName(g, id)));
      tr.appendChild(nameTd);

      tr.appendChild(cell(money(b.paid[id] || 0)));
      tr.appendChild(cell(money(b.owed[id] || 0)));

      var net = b.net[id] || 0;
      var netTd = el("td", "num bal-net " + (net > 0 ? "bal-net--pos" : net < 0 ? "bal-net--neg" : "bal-net--zero"));
      netTd.appendChild(document.createTextNode(net > 0 ? "+" + fmtCents(net) : fmtCents(net)));
      var tag = el("span", "bal-net__tag", net > 0 ? "is owed" : net < 0 ? "owes" : "even");
      netTd.appendChild(tag);
      tr.appendChild(netTd);

      body.appendChild(tr);
    });

    function cell(text) { var td = el("td", "num bal-cell", text); return td; }
  }

  /* ============================================================
     RENDER — settlement (headline output)
     ============================================================ */
  function renderSettlement() {
    var g = activeGroup();
    var list = $("#settlementList");
    var note = $("#settlementNote");
    list.innerHTML = "";

    if (!g.expenses.length) {
      note.className = "settlement__note";
      note.textContent = "Add an expense and evensplit works out who pays whom.";
      return;
    }

    var b = computeBalances(g);
    var transfers = settle(b.net);

    if (!transfers.length) {
      note.className = "settlement__note is-clear";
      note.textContent = "All square — nobody owes anybody. ✓";
      return;
    }

    transfers.forEach(function (t) {
      var li = el("li", "ledger-row");
      li.appendChild(el("span", "ledger-row__name", personName(g, t.from)));
      li.appendChild(el("span", "ledger-row__arrow", "pays"));
      var to = el("span", "ledger-row__to");
      to.appendChild(document.createTextNode(personName(g, t.to)));
      li.appendChild(to);
      li.appendChild(el("span", "ledger-row__amt", money(t.amt)));
      list.appendChild(li);
    });

    note.className = "settlement__note is-clear";
    note.textContent = transfers.length === 1
      ? "1 payment clears the whole house."
      : transfers.length + " payments clear the whole house.";
  }

  /* ============================================================
     RENDER — expense log
     ============================================================ */
  var METHOD_LABEL = { equal: "split equally", shares: "split by shares", exact: "exact amounts" };

  function renderLog() {
    var g = activeGroup();
    var log = $("#expenseLog");
    log.innerHTML = "";
    $("#expenseCount").textContent = String(g.expenses.length);

    if (!g.expenses.length) { $("#logEmpty").hidden = false; return; }
    $("#logEmpty").hidden = true;

    // newest first
    g.expenses.slice().reverse().forEach(function (exp) {
      var li = el("li", "log__item");
      li.appendChild(el("span", "log__desc", exp.desc));
      li.appendChild(el("span", "log__amt", money(exp.amount)));

      var meta = el("span", "log__meta");
      meta.appendChild(document.createTextNode(personName(g, exp.payer) + " paid • "));
      var m = el("em", null, METHOD_LABEL[exp.method] || exp.method);
      meta.appendChild(m);
      var count = exp.method === "exact" ? Object.keys(exp.exact).length : exp.participants.length;
      meta.appendChild(document.createTextNode(" • " + count + " " + (count === 1 ? "person" : "people")));
      li.appendChild(meta);

      var actions = el("span", "log__actions");
      var edit = el("button", "log__btn", "Edit"); edit.type = "button";
      edit.addEventListener("click", function () { startEdit(exp.id); });
      var del = el("button", "log__btn log__btn--del", "Delete"); del.type = "button";
      del.addEventListener("click", function () { deleteExpense(exp.id); });
      actions.appendChild(edit); actions.appendChild(del);
      li.appendChild(actions);

      log.appendChild(li);
    });
  }

  /* ============================================================
     ADD / EDIT / DELETE expense
     ============================================================ */
  function readExpenseForm() {
    var g = activeGroup();
    var desc = $("#expDesc").value.trim();
    var amount = parseCents($("#expAmount").value);
    var payer = $("#expPayer").value;
    var method = currentMethod();
    var chosen = selectedParticipants();

    var err = "";
    if (!desc) err = "Give the expense a description.";
    else if (amount == null || amount <= 0) err = "Enter an amount greater than zero.";
    else if (!payer || !personById(g, payer)) err = "Choose who paid.";
    else if (!chosen.length) err = "Tick at least one person to share this expense.";

    if (err) return { error: err };

    var exp = {
      id: editingId || uid(),
      desc: desc, amount: amount, payer: payer, method: method,
      participants: chosen.slice(), shares: {}, exact: {}
    };

    if (method === "shares") {
      var anyW = false;
      chosen.forEach(function (pid) {
        var inp = $('.part__input[data-pid="' + pid + '"]');
        var v = inp ? parseFloat((inp.value || "").replace(/[^0-9.]/g, "")) : NaN;
        if (isNaN(v) || v < 0) v = 0;
        exp.shares[pid] = v;
        if (v > 0) anyW = true;
      });
      if (!anyW) return { error: "Give at least one person a positive weight." };
    } else if (method === "exact") {
      var sum = 0, bad = false;
      chosen.forEach(function (pid) {
        var inp = $('.part__input[data-pid="' + pid + '"]');
        var c = inp ? parseCents(inp.value) : null;
        if (c == null) { bad = true; c = 0; }
        exp.exact[pid] = c;
        sum += c;
      });
      if (bad) return { error: "Every included person needs a valid exact amount." };
      if (sum !== amount) {
        var diff = amount - sum;
        return { error: "Exact amounts must add up to " + money(amount) + " (" +
          (diff > 0 ? money(diff) + " short" : money(-diff) + " over") + ")." };
      }
    }
    return { expense: exp };
  }

  function submitExpense(e) {
    e.preventDefault();
    var res = readExpenseForm();
    var errEl = $("#expenseError");
    if (res.error) { errEl.textContent = res.error; return; }
    errEl.textContent = "";

    var g = activeGroup();
    if (editingId) {
      for (var i = 0; i < g.expenses.length; i++) {
        if (g.expenses[i].id === editingId) { g.expenses[i] = res.expense; break; }
      }
      cancelEdit();
    } else {
      g.expenses.push(res.expense);
      resetExpenseInputs();
    }
    save();
    renderAll();
    showToast(editingId ? "Expense updated" : "Expense added");
  }

  function resetExpenseInputs() {
    $("#expDesc").value = "";
    $("#expAmount").value = "";
    // keep payer + participants for fast repeated entry; reset method to equal
    var eq = $('input[name=splitmethod][value=equal]');
    if (eq) eq.checked = true;
    renderParticipants();
  }

  function startEdit(id) {
    var g = activeGroup();
    var exp = null;
    for (var i = 0; i < g.expenses.length; i++) if (g.expenses[i].id === id) exp = g.expenses[i];
    if (!exp) return;
    editingId = id;

    $("#expDesc").value = exp.desc;
    $("#expAmount").value = fmtCents(exp.amount).replace(/,/g, "");
    var methodRadio = $('input[name=splitmethod][value="' + exp.method + '"]');
    if (methodRadio) methodRadio.checked = true;

    // payer (re-render select in case a former payer)
    renderPayerSelect();
    if (personById(g, exp.payer)) {
      // ensure the option exists even if payer is now inactive
      if (!$('#expPayer option[value="' + exp.payer + '"]')) {
        var opt = el("option", null, personName(g, exp.payer) + " (former)");
        opt.value = exp.payer;
        $("#expPayer").appendChild(opt);
      }
      $("#expPayer").value = exp.payer;
    }

    // rebuild participants with this expense's selections
    renderParticipantsFor(exp);

    $("#addExpenseBtn").textContent = "Save changes";
    $("#cancelEditBtn").hidden = false;
    $("#expenseError").textContent = "";
    var form = $("#expense-form");
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Like renderParticipants but pre-fills from an existing expense.
  function renderParticipantsFor(exp) {
    var g = activeGroup();
    var wrap = $("#participants");
    var method = exp.method;
    wrap.innerHTML = "";

    $("#splitHint").textContent =
      method === "equal"  ? "Split evenly among everyone you tick below." :
      method === "shares" ? "Give each person a weight (e.g. room size, or 2:1:1). Bigger weight = bigger share." :
                            "Type the exact amount each person owes. They must add up to the total.";

    // include active people plus any (former) people referenced by this expense
    var ids = activePeople(g).map(function (p) { return p.id; });
    (exp.participants || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });

    ids.forEach(function (id) {
      var included = (exp.participants || []).indexOf(id) !== -1;
      var row = el("div", "part" + (included ? "" : " part--off"));

      var chk = el("label", "part__check");
      var cb = el("input"); cb.type = "checkbox"; cb.value = id; cb.checked = included;
      cb.setAttribute("aria-label", "Include " + personName(g, id));
      cb.addEventListener("change", function () {
        row.classList.toggle("part--off", !cb.checked);
        var inp2 = $(".part__input", row);
        if (inp2) inp2.disabled = !cb.checked;
        updateReconcile();
      });
      chk.appendChild(cb);
      row.appendChild(chk);

      row.appendChild(el("span", "part__name", personName(g, id)));

      if (method === "equal") {
        var comp = el("span", "part__computed"); comp.dataset.pid = id;
        row.appendChild(comp);
      } else {
        var box = el("span", "part__value");
        var inp = el("input", "part__input");
        inp.type = "text"; inp.inputMode = "decimal"; inp.dataset.pid = id;
        inp.disabled = !included;
        inp.placeholder = method === "shares" ? "1" : "0.00";
        if (method === "shares") inp.value = exp.shares[id] != null ? String(exp.shares[id]) : "";
        else inp.value = exp.exact[id] != null ? fmtCents(exp.exact[id]).replace(/,/g, "") : "";
        inp.setAttribute("aria-label", (method === "shares" ? "Weight for " : "Exact amount for ") + personName(g, id));
        inp.addEventListener("input", updateReconcile);
        box.appendChild(inp);
        row.appendChild(box);
      }
      wrap.appendChild(row);
    });
    updateReconcile();
  }

  function cancelEdit() {
    editingId = null;
    $("#addExpenseBtn").textContent = "Add expense";
    $("#cancelEditBtn").hidden = true;
    $("#expenseError").textContent = "";
    resetExpenseInputs();
    renderPayerSelect();
  }

  function deleteExpense(id) {
    var g = activeGroup();
    g.expenses = g.expenses.filter(function (e) { return e.id !== id; });
    if (editingId === id) cancelEdit();
    save();
    renderAll();
    showToast("Expense deleted");
  }

  /* ============================================================
     PEOPLE — add
     ============================================================ */
  function addPerson(e) {
    e.preventDefault();
    var g = activeGroup();
    var input = $("#personName");
    var name = input.value.trim();
    if (!name) return;
    g.people.push({ id: uid(), name: name, active: true });
    input.value = "";
    save();
    renderAll();
    input.focus();
  }

  /* ============================================================
     GROUPS — new / rename / delete / switch
     ============================================================ */
  function newGroup() {
    var name = window.prompt("Name this house (e.g. “Flat 3B”, “Beach trip”):", "");
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var g = { id: uid(), name: name, people: [], expenses: [] };
    state.groups.push(g);
    state.activeId = g.id;
    cancelEdit();
    save();
    renderAll();
    $("#personName").focus();
  }

  function renameGroup() {
    var g = activeGroup();
    var name = window.prompt("Rename this house:", g.name);
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    g.name = name;
    save();
    renderAll();
  }

  function deleteGroup() {
    if (state.groups.length <= 1) return;
    var g = activeGroup();
    if (!window.confirm("Delete “" + g.name + "” and all its expenses? This can't be undone.")) return;
    state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
    state.activeId = state.groups[0].id;
    cancelEdit();
    save();
    renderAll();
  }

  function switchGroup(id) {
    if (!groupById(id)) return;
    state.activeId = id;
    cancelEdit();
    save();
    renderAll();
  }

  /* ============================================================
     COPY / SHARE plain-text summary
     ============================================================ */
  function buildSummaryText() {
    var g = activeGroup();
    var b = computeBalances(g);
    var lines = [];
    lines.push("evensplit — " + g.name);
    lines.push("");

    lines.push("BALANCES (paid − owed)");
    var ids = g.people.filter(function (p) {
      return p.active !== false || (b.paid[p.id] || b.owed[p.id]);
    }).map(function (p) { return p.id; });
    if (!g.expenses.length) {
      lines.push("  (no expenses yet)");
    } else {
      ids.forEach(function (id) {
        var net = b.net[id] || 0;
        var tag = net > 0 ? "is owed" : net < 0 ? "owes" : "even";
        var v = net === 0 ? "0.00" : (net > 0 ? "+" : "") + fmtCents(net);
        lines.push("  " + personName(g, id) + ": " + state.currency + v + " (" + tag + ")");
      });
    }
    lines.push("");

    lines.push("SETTLE UP");
    if (!g.expenses.length) {
      lines.push("  (nothing to settle)");
    } else {
      var transfers = settle(b.net);
      if (!transfers.length) {
        lines.push("  All square — nobody owes anybody.");
      } else {
        transfers.forEach(function (t) {
          lines.push("  " + personName(g, t.from) + " pays " + personName(g, t.to) + " " + money(t.amt));
        });
        lines.push("  (" + transfers.length + " " + (transfers.length === 1 ? "payment" : "payments") + ")");
      }
    }
    lines.push("");
    lines.push("Figures are informal — verify before paying. Made with evensplit.");
    return lines.join("\n");
  }

  function copySummary() {
    var text = buildSummaryText();
    var done = function () { showToast("Summary copied to clipboard"); };
    var fail = function () { fallbackCopy(text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      fallbackCopy(text);
    }
  }
  // Clipboard fallback that needs no network (execCommand on a temp textarea).
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      showToast(ok ? "Summary copied to clipboard" : "Press Ctrl/Cmd+C to copy");
    } catch (e) {
      showToast("Couldn't copy — select the summary manually");
    }
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function showToast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ============================================================
     RENDER ALL
     ============================================================ */
  function renderAll() {
    // keep currency symbol control in sync
    $("#currencyInput").value = state.currency;
    $("#amtSym").textContent = state.currency;

    renderGroupSelect();
    renderPeople();
    renderPayerSelect();
    if (!editingId) renderParticipants();
    renderBalances();
    renderSettlement();
    renderLog();
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    load();

    $("#addPersonForm").addEventListener("submit", addPerson);
    $("#expenseForm").addEventListener("submit", submitExpense);
    $("#cancelEditBtn").addEventListener("click", cancelEdit);
    $("#copyBtn").addEventListener("click", copySummary);

    $("#newGroupBtn").addEventListener("click", newGroup);
    $("#renameGroupBtn").addEventListener("click", renameGroup);
    $("#deleteGroupBtn").addEventListener("click", deleteGroup);
    $("#groupSelect").addEventListener("change", function () { switchGroup(this.value); });

    // currency symbol edits
    $("#currencyInput").addEventListener("input", function () {
      var v = this.value.trim();
      state.currency = v || "₹";
      $("#amtSym").textContent = state.currency;
      save();
      // refresh figures without rebuilding the form inputs
      renderBalances();
      renderSettlement();
      renderLog();
      updateReconcile();
    });

    // amount + method changes drive the live reconcile preview
    $("#expAmount").addEventListener("input", updateReconcile);
    // Switching split method rebuilds the participant inputs (keeping selections).
    $$('input[name=splitmethod]').forEach(function (r) {
      r.addEventListener("change", function () { renderParticipants(); });
    });

    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
