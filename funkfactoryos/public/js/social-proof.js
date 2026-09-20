// Reusable SocialProof component for FFMG Express landing / pricing / thanks pages.
// Scans for [data-social-proof][data-placement] markers on DOMContentLoaded, fetches
// /data/social-proof.json once, distributes the count + rotator into each marker,
// and fires GA4 + server-side row-per-placement tracking when the marker scrolls into view.
//
// Markup contract (per placement; identical to pricing.html's existing static trust-items):
//
//   <div class="trust-item" data-social-proof data-placement="pricing_mid">
//     <svg class="trust-icon" ...></svg>
//     <span class="trust-text"><span data-sp-count>50+</span> websites &amp; media projects shipped</span>
//   </div>
//   <div class="trust-item" data-social-proof data-placement="pricing_mid">
//     <svg class="trust-icon" ...></svg>
//     <span class="trust-text" data-sp-rotator style="transition: opacity 0.2s">
//       <span data-sp-event>Sports photography</span> in
//       <strong data-sp-city>Albuquerque, NM</strong> ·
//       <span data-sp-when>recent</span>
//     </span>
//   </div>
//
// Reuses the existing .trust-strip / .trust-inner / .trust-item / .trust-icon / .trust-text CSS
// already declared on each page — this script does not bundle any styles.
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function dnt() {
    return navigator.doNotTrack === '1' || window.doNotTrack === '1';
  }

  function formatCount(n) {
    if (n >= 1000) return Math.floor(n / 100) / 10 + 'K+';
    return n + '+';
  }

  function fireViewed(placement, clientsServedNum, winCount) {
    if (dnt()) return;
    // GA4 (no-op if gtag absent)
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'social_proof_viewed', {
        placement: placement,
        page_path: window.location.pathname,
        clients_served: clientsServedNum,
        win_count: winCount
      });
    }
    // Server-side row-per-placement tracking (mirrors /api/analytics/pageview contract)
    try {
      fetch('/api/analytics/social-proof-viewed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placement: placement, path: window.location.pathname }),
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* never block user-facing render */ }
  }

  ready(function () {
    var containers = Array.prototype.slice.call(document.querySelectorAll('[data-social-proof]'));
    if (containers.length === 0) return;

    // Group markers by placement so we share fetch results + fire one event per placement.
    var byPlacement = {};
    containers.forEach(function (c) {
      var p = c.getAttribute('data-placement') || 'unknown';
      if (!byPlacement[p]) byPlacement[p] = [];
      byPlacement[p].push(c);
    });

    var clientsServedNum = null;
    var wins = [];

    function distributeCounts() {
      Object.keys(byPlacement).forEach(function (placement) {
        byPlacement[placement].forEach(function (c) {
          var countEl = c.querySelector('[data-sp-count]');
          if (countEl && clientsServedNum != null) {
            countEl.textContent = formatCount(clientsServedNum);
          }
        });
      });
    }

    function startRotator() {
      // Each page has at most one rotator marker per unique placement; run one interval
      // per page-positioned rotator (the marker whose parent .trust-item lives inside
      // a visible trust-strip on the page).
      Object.keys(byPlacement).forEach(function (placement) {
        var rotator = null;
        var eEl = null, cEl = null, wEl = null;
        byPlacement[placement].forEach(function (c) {
          if (rotator) return;
          var r = c.querySelector('[data-sp-rotator]');
          var e = c.querySelector('[data-sp-event]');
          var city = c.querySelector('[data-sp-city]');
          var when = c.querySelector('[data-sp-when]');
          if (r && e && city && when) {
            rotator = r;
            eEl = e;
            cEl = city;
            wEl = when;
          }
        });
        if (!rotator || wins.length === 0) return;
        var idx = 0;
        setInterval(function () {
          rotator.style.opacity = '0';
          setTimeout(function () {
            idx = (idx + 1) % wins.length;
            var w = wins[idx];
            eEl.textContent = w.event_type;
            cEl.textContent = w.city;
            wEl.textContent = w.when || 'recent';
            rotator.style.opacity = '1';
          }, 200);
        }, 5000);
      });
    }

    fetch('/data/social-proof.json')
      .then(function (res) {
        if (!res.ok) throw new Error('non-200');
        return res.json();
      })
      .then(function (data) {
        var n = (data && typeof data.clients_served === 'number') ? data.clients_served : null;
        if (n != null && n > 0) clientsServedNum = n;
        if (data && Array.isArray(data.recent_wins) && data.recent_wins.length > 0) {
          wins = data.recent_wins.filter(function (w) {
            return w && typeof w.event_type === 'string' && typeof w.city === 'string';
          });
        }
        distributeCounts();
        startRotator();
      })
      .catch(function () {
        // Keep hardcoded fallbacks already present in the markup.
      });

    // One IntersectionObserver per placement, driving a single viewed event.
    if (dnt()) return;
    if (!('IntersectionObserver' in window)) return;

    Object.keys(byPlacement).forEach(function (placement) {
      var list = byPlacement[placement];
      var target = list[0];
      var fired = false;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !fired) {
            fired = true;
            fireViewed(placement, clientsServedNum, wins.length);
            io.disconnect();
          }
        });
      }, { rootMargin: '0px' });
      io.observe(target);
    });
  });
})();
