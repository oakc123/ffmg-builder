(function () {
    'use strict';

    // Inject shared styles once (data-nc-init flag on body prevents double injection)
    if (!document.body.hasAttribute('data-nc-init')) {
        document.body.setAttribute('data-nc-init', 'true');
        var style = document.createElement('style');
        style.id = 'nc-nav-cta-styles';
        style.textContent = [
            '/* ===== NAV PROGRESS BAR ===== */',
            '.nav-progress{position:fixed;top:64px;left:0;right:0;z-index:99;height:3px;background:transparent;pointer-events:none;}',
            '.nav-progress-bar{height:100%;background:var(--accent,#D4956A);transition:width .1s linear;}',
            '/* ===== NAV SOCIAL PROOF ===== */',
            '.nav-social-proof{font-size:.72rem;color:var(--text-muted,#6b5c50);opacity:0;transition:opacity .4s;white-space:nowrap;line-height:1;}',
            '.nav-social-proof.visible{opacity:1;}',
            '/* ===== SCROLL PANEL ===== */',
            '.scroll-panel{position:fixed;bottom:28px;right:28px;z-index:250;background:var(--bg-warm,#faf6f1);border:1px solid var(--border,rgba(107,58,31,.1));border-radius:10px;padding:14px 40px 14px 20px;box-shadow:0 4px 20px rgba(26,15,8,.1);font-size:.88rem;color:var(--text,#1a0f08);line-height:1.5;opacity:0;transform:translateY(12px);transition:opacity .3s,transform .3s;pointer-events:none;}',
            '.scroll-panel.visible{opacity:1;transform:translateY(0);pointer-events:auto;}',
            '.sp-inner{display:flex;align-items:center;gap:6px;}',
            '.sp-text{color:var(--text,#1a0f08);}',
            '.sp-link{color:var(--accent-dark,#6B3A1F);font-weight:600;text-decoration:none;}',
            '.sp-link:hover{text-decoration:underline;}',
            '.scroll-panel-close{position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:1.2rem;color:var(--text-muted,#6b5c50);line-height:1;padding:0;}',
            '.scroll-panel-close:hover{color:var(--text,#1a0f08);}'
        ].join('\n');
        document.head.appendChild(style);
    }

    var navCtaBtn = document.getElementById('navCtaBtn');
    var navProgress = document.getElementById('navProgress');
    var navSocialProof = document.getElementById('navSocialProof');
    var scrollPanel = document.getElementById('scrollPanel');
    var scrollPanelClose = document.getElementById('scrollPanelClose');

    // ─── 1. SCROLL PROGRESS BAR ───────────────────────────────────────────────
    if (navProgress) {
        var bar = document.createElement('div');
        bar.className = 'nav-progress-bar';
        navProgress.appendChild(bar);

        function updateProgress() {
            var scrollY = window.scrollY;
            var docH = document.documentElement.scrollHeight - window.innerHeight;
            var pct = docH > 0 ? Math.min(100, (scrollY / docH) * 100) : 0;
            bar.style.width = pct + '%';
        }
        window.addEventListener('scroll', updateProgress, { passive: true });
        updateProgress();
    }

    // ─── 2. DYNAMIC NAV CTA LABEL ─────────────────────────────────────────────
    if (navCtaBtn) {
        // Find the first meaningful content section (hero or page-hero)
        var heroSection = document.querySelector('section.hero, section.page-hero');
        var heroThreshold = 0;

        if (heroSection) {
            heroThreshold = heroSection.offsetTop + heroSection.offsetHeight;
        }

        function updateNavCta() {
            var scrollY = window.scrollY;
            var docH = document.documentElement.scrollHeight;
            var bottomZone = docH * 0.85;

            if (scrollY >= bottomZone) {
                navCtaBtn.textContent = "Let's Talk";
                navCtaBtn.style.background = 'var(--accent-dark, #6B3A1F)';
            } else if (scrollY >= heroThreshold) {
                navCtaBtn.textContent = "Start Your Project →";
                navCtaBtn.style.background = '';
                navCtaBtn.style.backgroundColor = '';
            } else {
                navCtaBtn.textContent = "Get a Quote";
                navCtaBtn.style.background = '';
                navCtaBtn.style.backgroundColor = '';
            }
        }

        window.addEventListener('scroll', updateNavCta, { passive: true });
        updateNavCta();
    }

    // ─── 3. SOCIAL PROOF (delayed 3s) ──────────────────────────────────────────
    if (navSocialProof) {
        setTimeout(function () {
            navSocialProof.classList.add('visible');
        }, 3000);
    }

    // ─── 4. SCROLL-TRIGGERED QUOTE PANEL ──────────────────────────────────────
    // Only show on pages other than /intake; dismissible per session
    if (scrollPanel && !/^\/intake(\/|$)/.test(window.location.pathname)) {
        var panelShown = false;

        function showPanel() {
            if (panelShown) return;
            panelShown = true;
            scrollPanel.classList.add('visible');
            sessionStorage.setItem('sp-dismissed', '1');
        }

        function hidePanel() {
            scrollPanel.classList.remove('visible');
        }

        // Do not show if already dismissed this session
        if (sessionStorage.getItem('sp-dismissed') === '1') {
            // Still track scroll but don't auto-show
        } else {
            window.addEventListener('scroll', function () {
                var docH = document.documentElement.scrollHeight - window.innerHeight;
                if (docH > 0 && window.scrollY > docH * 0.6) {
                    showPanel();
                }
            }, { passive: true });
        }

        if (scrollPanelClose) {
            scrollPanelClose.addEventListener('click', hidePanel);
        }
    }

})();