/* EyeTalk Landing — 轻量交互脚本（与 app.js 完全隔离） */
(function () {
  "use strict";

  // Intersection Observer 通用工厂
  function watch(selector, callback, opts) {
    var els = document.querySelectorAll(selector);
    if (!els.length) return;
    var ob = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { callback(e.target); ob.unobserve(e.target); }
      });
    }, opts || { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    els.forEach(function (el) { ob.observe(el); });
  }

  // 1. 滚动淡入
  watch(".reveal", function (el) { el.classList.add("visible"); });

  // 2. 导航栏滚动态
  var nav = document.querySelector(".nav");
  if (nav) {
    var updateNav = function () {
      nav.classList.toggle("scrolled", window.scrollY > 50);
    };
    window.addEventListener("scroll", updateNav, { passive: true });
    updateNav();
  }

  // 3. 平滑锚点
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var t = document.querySelector(a.getAttribute("href"));
      if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
    });
  });

  // 4. 涟漪效果
  document.querySelectorAll(".btn-primary").forEach(function (btn) {
    btn.style.position = "relative";
    btn.style.overflow = "hidden";
    btn.addEventListener("click", function (e) {
      var r = btn.getBoundingClientRect();
      var s = Math.max(r.width, r.height);
      var sp = document.createElement("span");
      sp.style.cssText = "position:absolute;border-radius:50%;pointer-events:none;width:" + s + "px;height:" + s + "px;left:" + (e.clientX - r.left - s / 2) + "px;top:" + (e.clientY - r.top - s / 2) + "px;background:rgba(255,255,255,0.3);transform:scale(0);animation:ripple .6s ease-out forwards";
      btn.appendChild(sp);
      setTimeout(function () { sp.remove(); }, 700);
    });
  });

  // 注入涟漪 keyframes
  var s = document.createElement("style");
  s.textContent = "@keyframes ripple{to{transform:scale(2.5);opacity:0}}";
  document.head.appendChild(s);

  // 5. 数字递增
  watch("[data-count]", function (el) {
    var target = +el.getAttribute("data-count");
    var suffix = el.getAttribute("data-suffix") || "";
    var start = null;
    (function tick(now) {
      if (!start) start = now;
      var p = Math.min((now - start) / 1200, 1);
      el.textContent = Math.floor((1 - Math.pow(1 - p, 4)) * target) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;
    })(performance.now());
  }, { threshold: 0.3 });

  // 6. 光晕视差
  var glows = document.querySelectorAll(".hero-glow");
  if (glows.length) {
    var raf = 0;
    document.addEventListener("mousemove", function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        var mx = (e.clientX / innerWidth - 0.5) * 2;
        var my = (e.clientY / innerHeight - 0.5) * 2;
        glows.forEach(function (g, i) {
          var f = (i + 1) * 12;
          g.style.transform = g.classList.contains("hero-glow--cyan")
            ? "translate(calc(-50%+" + mx * f + "px),calc(-50%+" + my * f + "px))"
            : "translate(" + mx * f + "px," + my * f + "px)";
        });
        raf = 0;
      });
    });
  }

})();
