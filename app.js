import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { collection, deleteDoc, doc, getDoc, getDocs, getFirestore, query, serverTimestamp, setDoc, where } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

(() => {
  "use strict";

  const STORAGE_KEY = "buildflow.workspace.v1";
  const GROQ_API_KEY = "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";
  const LIMITS = { history: 30, assetBytes: 3 * 1024 * 1024 };
  const examples = [
    { name: "Northline Studio", category: "Portfolio", tone: "An independent design practice" },
    { name: "Vero Coffee", category: "Restaurant", tone: "A neighborhood coffee shop" },
    { name: "Fieldnotes", category: "SaaS", tone: "A calmer way to plan your week" },
  ];

  const blankState = () => ({ projects: [], localProjects: [], activeId: null, assets: [], localAssets: [], authReady: false });
  let state = loadState();
  let currentView = "dashboard";
  let selectedSection = 0;
  let previewWidth = "100%";
  const editorHistory = new Map();
  let firebaseApp = null;
  let auth = null;
  let db = null;
  let functions = null;
  let session = null;
  let isAdmin = false;
  let saveTimer = null;
  let searchTerm = "";
  let adminStatus = "idle";
  let adminError = "";
  let adminUsers = [];
  let adminPage = 1;
  let adminTotal = 0;
  let adminActive = 0;
  let adminSearch = "";

  const $ = (selector, root = document) => root.querySelector(selector);
  const content = $("#content");
  const firebaseConfig = window.BUILDFLOW_CONFIG || {};

  function isFirebaseConfigured() {
    return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (parsed && Array.isArray(parsed.projects)) return { ...blankState(), ...parsed };
    } catch (error) {
      console.warn("BuildFlow workspace could not be read:", error);
    }
    return blankState();
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (auth && session) syncActiveProject();
    } catch (error) {
      toast(error.name === "QuotaExceededError" ? "Browser storage is full. Remove a large asset and try again." : "Could not save this change.", "error");
    }
    updateChrome();
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function starterSpec(name, prompt, category = "Studio") {
    const business = name || "Your new website";
    const phrase = prompt || `A thoughtful ${category.toLowerCase()} website.`;
    return {
      name: business,
      description: phrase,
      theme: { background: "#f4f1e9", foreground: "#1c2923", accent: "#297455", font: "DM Sans" },
      pages: [{ name: "Home", slug: "/", sections: [
        { type: "hero", title: business, text: phrase, button: "Discover more" },
        { type: "features", title: "Made with intention", text: "A clear, welcoming place for your next idea." },
        { type: "about", title: "A little about us", text: "Tell your visitors what makes this work meaningful." },
        { type: "cta", title: "Let's make something good.", text: "Start a conversation and take the next step.", button: "Get in touch" },
      ] }],
    };
  }

  function createProject(name, prompt, category) {
    const project = {
      id: crypto.randomUUID(), name: name.trim() || "Untitled website", prompt: prompt.trim(),
      spec: starterSpec(name.trim() || "Untitled website", prompt.trim(), category),
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), versions: [],
      status: "Draft", origin: "local", framework: "HTML, CSS & JS",
    };
    state.projects.unshift(project);
    state.activeId = project.id;
    addVersion(project, "Starter website created");
    persist();
    return project;
  }

  function activeProject() { return state.projects.find((project) => project.id === state.activeId) || null; }

  function addVersion(project, label) {
    const copy = JSON.parse(JSON.stringify(project.spec));
    project.versions.unshift({ id: crypto.randomUUID(), label, createdAt: new Date().toISOString(), spec: copy });
    project.versions = project.versions.slice(0, LIMITS.history);
    project.updatedAt = new Date().toISOString();
  }

  function checkpoint(project) {
    let history = editorHistory.get(project.id);
    if (!history) {
      history = { past: [], future: [], last: JSON.stringify(project.spec) };
      editorHistory.set(project.id, history);
    }
    const current = JSON.stringify(project.spec);
    if (history.last !== current) {
      history.past.push(history.last);
      history.past = history.past.slice(-30);
      history.future = [];
      history.last = current;
    }
  }

  function changeHistory(direction) {
    const project = activeProject();
    if (!project) return;
    let history = editorHistory.get(project.id);
    if (!history) {
      history = { past: [], future: [], last: JSON.stringify(project.spec) };
      editorHistory.set(project.id, history);
    }
    const source = direction === "undo" ? history.past : history.future;
    if (!source.length) { toast(direction === "undo" ? "Nothing to undo yet." : "Nothing to redo yet."); return; }
    const destination = direction === "undo" ? history.future : history.past;
    destination.push(JSON.stringify(project.spec));
    project.spec = JSON.parse(source.pop());
    history.last = JSON.stringify(project.spec);
    project.updatedAt = new Date().toISOString();
    persist();
    renderEditor();
    toast(direction === "undo" ? "Change undone." : "Change redone.");
  }

  function updateChrome() {
    $("#project-count").textContent = String(state.projects.length);
    $("#connection-status").innerHTML = auth && session ? "<i class='online'></i> Firebase" : "<i></i> Local only";
    $("#profile-name").textContent = session?.displayName || session?.email?.split("@")[0] || "My workspace";
    $("#profile-email").textContent = session?.email || "Local mode";
    $("#account-link").innerHTML = `<span class="nav-icon">◎</span>${session ? "Account / sign out" : "Log in / sign up"}`;
    $("#admin-link").hidden = !session || !isAdmin;
  }

  function toast(message, kind = "success") {
    const element = document.createElement("div");
    element.className = `toast toast-${kind}`;
    element.textContent = message;
    $("#toast-region").append(element);
    setTimeout(() => element.remove(), 3500);
  }

  function setView(view) {
    if (auth && (!session || !session.emailVerified) && view !== "auth") {
      view = "auth";
      toast("Sign in to open your workspace.", "error");
    }
    if (view === "admin" && (!session || !isAdmin)) {
      adminStatus = "denied";
      adminError = !auth ? "Connect Firebase and sign in before using the administrator panel." : !session ? "Sign in with an administrator account to view this page." : "This account does not have the admin role.";
    } else if (view === "admin") {
      adminStatus = "idle";
      adminError = "";
    }
    currentView = view;
    document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $("#breadcrumb-current").textContent = ({ dashboard: "Overview", projects: "Projects", templates: "Templates", assets: "Assets", versions: "Version history", assistant: "AI assistant", admin: "Admin", settings: "Settings", editor: "Editor", preview: "Preview", auth: "Log in / sign up" })[view] || view;
    $("#sidebar").classList.remove("sidebar-open");
    render();
  }

  function render() {
    const routes = { dashboard: renderDashboard, projects: renderProjects, templates: renderTemplates, assets: renderAssets, versions: renderVersions, assistant: renderAssistant, admin: renderAdmin, settings: renderSettings, editor: renderEditor, preview: renderPreview, auth: renderAuth };
    (routes[currentView] || renderDashboard)();
  }

  function relativeDate(date) {
    const minutes = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
    return `${Math.floor(minutes / 1440)} days ago`;
  }

  function projectCard(project, index) {
    const backgrounds = ["#dbe7dc", "#f0e7d5", "#dce7e9"];
    const accent = project.spec?.theme?.accent || "#297455";
    return `<article class="project-card" style="--preview-bg:${backgrounds[index % backgrounds.length]};--preview-accent:${escapeHtml(accent)}">
      <button class="project-thumb" data-open-project="${project.id}" aria-label="Open ${escapeHtml(project.name)}"><span class="thumb-window"><i></i><i></i><i></i></span><span class="thumb-copy"><small>${escapeHtml(project.spec?.pages?.[0]?.name || "HOME")}</small><strong>${escapeHtml(project.name)}</strong><em>${escapeHtml(project.spec?.pages?.[0]?.sections?.[0]?.text || "A website made for what comes next.")}</em><b>${escapeHtml(project.spec?.pages?.[0]?.sections?.[0]?.button || "Learn more")} →</b></span></button>
      <div class="project-card-copy"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.spec?.pages?.[0]?.sections?.length || 0)} sections · Edited ${relativeDate(project.updatedAt)}</p></div><button class="icon-button project-menu" data-project-menu="${project.id}" aria-label="Project options">···</button></div>
    </article>`;
  }

  function renderDashboard() {
    const projects = state.projects.slice(0, 3);
    content.innerHTML = `<section class="welcome-row"><div><div class="eyebrow"><span class="eyebrow-line"></span>YOUR WORKSPACE</div><h1>Good ideas deserve<br /><span>a place to grow.</span></h1><p class="welcome-copy">Shape your next website, one thoughtful decision at a time.</p></div><button class="button button-primary" data-action="new-project"><span>＋</span> New project</button></section>
      <section class="quickstart-panel"><div class="quickstart-art" aria-hidden="true"><div class="art-sun"></div><div class="art-hill art-hill-back"></div><div class="art-hill art-hill-front"></div><div class="art-path"></div><span class="art-star">✳</span><span class="art-dot dot-one"></span><span class="art-dot dot-two"></span></div><div class="quickstart-content"><span class="quickstart-kicker">A GOOD PLACE TO START</span><h2>What are you imagining?</h2><p>Describe a website and let AI build an editable first version.</p><form id="quickstart-form" class="prompt-bar"><span class="prompt-spark">✳</span><input id="quickstart-prompt" name="prompt" placeholder="A ceramics studio with a quiet, earthy feel..." aria-label="Describe your website" required /><button class="prompt-submit" aria-label="Build website with AI">→</button></form><div class="prompt-hints"><span>Try:</span><button type="button" data-prompt="A warm bakery with a daily menu">bakery</button><button type="button" data-prompt="A portfolio for an editorial photographer">photography portfolio</button><button type="button" data-prompt="A clean landing page for a new productivity app">SaaS landing page</button></div></div></section>
      <section class="section-heading"><div><div class="eyebrow">YOUR WORK</div><h2>Recent projects <span class="heading-count">${state.projects.length}</span></h2></div><button class="text-button" data-view="projects">All projects <span>→</span></button></section>
      ${projects.length ? `<div class="project-grid">${projects.map(projectCard).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">↗</div><h3>Your next idea starts here.</h3><p>Create a first draft, then edit its content and style in your workspace.</p><button class="button button-secondary" data-action="new-project">Create your first project</button></div>`}
      <section class="bottom-note"><span class="note-mark">i</span><div><strong>Start small, stay in control.</strong><p>Drafts are stored on this device. Connect Firebase in Settings for account-based sync.</p></div><button class="text-button" data-view="settings">Setup guide <span>→</span></button></section>`;
  }

  function renderProjects() {
    let projects = [...state.projects];
    if (searchTerm) projects = projects.filter((project) => project.name.toLowerCase().includes(searchTerm.toLowerCase()));
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">YOUR WORKSPACE</div><h1>Projects</h1><p>All the sites you’re shaping, in one place.</p></div><button class="button button-primary" data-action="new-project">＋ New project</button></section><div class="toolbar-row"><label class="search-field"><span>⌕</span><input id="project-search" placeholder="Find a project" value="${escapeHtml(searchTerm)}" /></label><span class="muted-label">${projects.length} ${projects.length === 1 ? "project" : "projects"}</span></div>${projects.length ? `<div class="project-grid">${projects.map(projectCard).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">▤</div><h3>${searchTerm ? "No matching projects." : "Nothing here yet."}</h3><p>${searchTerm ? "Try another search." : "Create your first site to start building."}</p><button class="button button-secondary" data-action="new-project">＋ Create a project</button></div>`}`;
    const search = $("#project-search");
    search?.addEventListener("input", (event) => { searchTerm = event.target.value; renderProjects(); $("#project-search")?.focus(); });
  }

  const templateData = [
    { name: "Studio Folio", category: "Portfolio", description: "An editorial home for independent creatives.", mark: "sf", colors: ["#e9e4d7", "#466e5a"] },
    { name: "Sunday Table", category: "Restaurant", description: "A welcoming neighborhood restaurant site.", mark: "st", colors: ["#f0dfcc", "#a95637"] },
    { name: "Fieldnotes", category: "SaaS", description: "A focused launch page for your next product.", mark: "fn", colors: ["#e1e9e3", "#3d6956"] },
    { name: "Atelier North", category: "Agency", description: "A considered home for a small creative team.", mark: "an", colors: ["#e8e6e1", "#4d5d69"] },
    { name: "Common Ground", category: "Barber", description: "A confident, characterful neighborhood shop.", mark: "cg", colors: ["#e6e2d5", "#826441"] },
    { name: "Good Form", category: "Fitness", description: "An energetic introduction to your studio.", mark: "gf", colors: ["#e2e6dc", "#587046"] },
  ];

  function renderTemplates() {
    setView("assistant");
  }

  function renderEditor() {
    const project = activeProject();
    if (!project) { setView("projects"); return; }
    if (project.spec.generatedHtml) {
      content.innerHTML = `<section class="editor-topline"><div><button class="text-button" data-view="projects">← Projects</button><span class="editor-divider">/</span><strong>${escapeHtml(project.name)}</strong><span class="save-indicator"><i></i> Saved locally</span></div><div class="editor-actions"><button class="button button-small button-outline" data-view="preview">Preview ↗</button></div></section><div class="preview-frame-wrap"><iframe class="preview-frame" title="${escapeHtml(project.name)} generated website" sandbox="allow-scripts allow-forms" srcdoc="${escapeHtml(project.spec.generatedHtml)}"></iframe></div>`;
      return;
    }
    if (!editorHistory.has(project.id)) editorHistory.set(project.id, { past: [], future: [], last: JSON.stringify(project.spec) });
    const page = project.spec.pages[0];
    selectedSection = Math.min(selectedSection, page.sections.length - 1);
    const selected = page.sections[selectedSection] || page.sections[0];
    const accent = project.spec.theme.accent;
    content.innerHTML = `<section class="editor-topline"><div><button class="text-button" data-view="projects">← Projects</button><span class="editor-divider">/</span><strong>${escapeHtml(project.name)}</strong><span class="save-indicator"><i></i> Saved locally</span></div><div class="editor-actions"><button class="icon-button" data-action="undo" title="Undo">↶</button><button class="icon-button" data-action="redo" title="Redo">↷</button><div class="viewport-switch" aria-label="Preview width"><button class="viewport-button ${previewWidth === "100%" ? "selected" : ""}" data-width="100%" title="Desktop">▰</button><button class="viewport-button ${previewWidth === "768px" ? "selected" : ""}" data-width="768px" title="Tablet">▭</button><button class="viewport-button ${previewWidth === "390px" ? "selected" : ""}" data-width="390px" title="Mobile">▯</button></div><button class="button button-small button-outline" data-view="preview">Preview ↗</button></div></section>
      <div class="editor-layout"><aside class="editor-left"><div class="panel-title"><span>PAGE STRUCTURE</span><button class="icon-button compact" data-action="add-section" title="Add section">＋</button></div><div class="page-pill">⌑ &nbsp; Home <span>⌄</span></div><div class="layer-list">${page.sections.map((section, index) => `<button class="layer-item ${index === selectedSection ? "selected" : ""}" data-select-section="${index}" data-drag-index="${index}" draggable="true"><span class="layer-symbol">${section.type === "hero" ? "▣" : section.type === "cta" ? "◉" : "▤"}</span><span>${escapeHtml(section.title || section.type)}</span><span class="layer-drag">⠿</span></button>`).join("")}</div><button class="add-layer" data-action="add-section">＋ Add section</button><div class="layer-spacer"></div><div class="panel-footnote">Changes save to this browser automatically.</div></aside>
      <section class="canvas-area"><div class="canvas-toolbar"><span>HOME <i>·</i> ${escapeHtml(project.name.toUpperCase())}</span><span class="canvas-mode">DESIGN</span></div><div class="canvas-outer"><div class="site-canvas" id="site-canvas" style="width:${escapeHtml(previewWidth)};--site-bg:${escapeHtml(project.spec.theme.background)};--site-fg:${escapeHtml(project.spec.theme.foreground)};--site-accent:${escapeHtml(accent)}"><div class="site-nav"><strong>${escapeHtml(project.name)}</strong><span>About　 Services　 Contact</span><button>Let's talk ↗</button></div>${page.sections.map((section, index) => `<section class="site-section site-${escapeHtml(section.type)} ${index === selectedSection ? "site-selected" : ""}" data-canvas-section="${index}"><span class="section-badge">${escapeHtml(section.type)}</span><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.text || "Share the details that make your work worth discovering.")}</p>${section.button ? `<button class="site-cta">${escapeHtml(section.button)} <span>↗</span></button>` : ""}</section>`).join("")}<footer class="site-footer">${escapeHtml(project.name)} <span>Thoughtfully made.</span></footer></div></div></section>
      <aside class="editor-right"><div class="panel-title">PROPERTIES <span class="property-type">${escapeHtml(selected?.type || "section")}</span></div>${selected ? `<label class="field-label">Section title<input id="property-title" value="${escapeHtml(selected.title || "")}" /></label><label class="field-label">Supporting text<textarea id="property-text" rows="4">${escapeHtml(selected.text || "")}</textarea></label><label class="field-label">Button label<input id="property-button" value="${escapeHtml(selected.button || "")}" /></label><div class="property-divider"></div><div class="field-label">Page colors</div><label class="color-row">Background <input id="property-background" type="color" value="${escapeHtml(project.spec.theme.background)}" /></label><label class="color-row">Accent <input id="property-accent" type="color" value="${escapeHtml(accent)}" /></label><div class="property-divider"></div><button class="button button-small button-outline full-width" data-action="delete-section">Delete section</button>` : ""}<div class="property-spacer"></div><button class="button button-primary full-width" data-action="save-version">Save version</button></aside></div>`;
  }

  function bindEditorInputs() {
    const project = activeProject();
    const section = project?.spec.pages[0].sections[selectedSection];
    if (!section) return;
    const update = (key, value) => { section[key] = value; checkpoint(project); project.updatedAt = new Date().toISOString(); persist(); renderEditor(); };
    $("#property-title")?.addEventListener("change", (event) => update("title", event.target.value));
    $("#property-text")?.addEventListener("change", (event) => update("text", event.target.value));
    $("#property-button")?.addEventListener("change", (event) => update("button", event.target.value));
    $("#property-background")?.addEventListener("input", (event) => { $("#site-canvas").style.setProperty("--site-bg", event.target.value); });
    $("#property-background")?.addEventListener("change", (event) => { project.spec.theme.background = event.target.value; checkpoint(project); persist(); });
    $("#property-accent")?.addEventListener("input", (event) => { $("#site-canvas").style.setProperty("--site-accent", event.target.value); });
    $("#property-accent")?.addEventListener("change", (event) => { project.spec.theme.accent = event.target.value; checkpoint(project); persist(); });
  }

  function renderAssets() {
    const assets = state.assets;
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">PROJECT LIBRARY</div><h1>Assets (Not available for now)</h1><p>Images you’ve added to this workspace.</p></div><button class="button button-primary" data-action="upload-asset" disabled>＋ Upload image</button></section><div class="asset-note">Asset uploads are temporarily unavailable. You can still keep using the project in local mode.</div>${assets.length ? `<div class="asset-grid">${assets.map((asset, index) => `<article class="asset-card"><img src="${asset.data}" alt="${escapeHtml(asset.name)}" /><div><strong>${escapeHtml(asset.name)}</strong><span>${(asset.size / 1024).toFixed(0)} KB · ${relativeDate(asset.createdAt)}</span></div><button class="icon-button" data-delete-asset="${index}" aria-label="Delete ${escapeHtml(asset.name)}">×</button></article>`).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">▧</div><h3>Your library is ready.</h3><p>Upload a small image to keep it handy while you work.</p><button class="button button-secondary" data-action="upload-asset" disabled>Choose an image</button></div>`}`;
  }

  function renderVersions() {
    const project = activeProject();
    const versions = project?.versions || [];
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">PROJECT HISTORY</div><h1>Version history</h1><p>Restore a saved snapshot without losing the current draft.</p></div>${project ? `<button class="button button-primary" data-action="save-version">＋ Save version</button>` : ""}</section>${project ? `<div class="history-project">Current project <strong>${escapeHtml(project.name)}</strong></div>${versions.length ? `<div class="version-list">${versions.map((version, index) => `<article class="version-row"><span class="version-number">v${versions.length - index}</span><div class="version-info"><strong>${escapeHtml(version.label)}</strong><span>${new Date(version.createdAt).toLocaleString()}</span></div><button class="button button-small button-outline" data-restore-version="${version.id}">Restore</button></article>`).join("")}</div>` : `<div class="empty-state"><h3>No saved versions yet.</h3><p>Save a project version from the editor to keep a restore point.</p><button class="button button-secondary" data-view="editor">Open editor</button></div>`}` : `<div class="empty-state"><h3>Choose a project first.</h3><p>Version history belongs to an individual project.</p><button class="button button-secondary" data-view="projects">Browse projects</button></div>`}`;
  }

  function renderAssistant() {
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">AI WEBSITE BUILDER</div><h1>AI assistant</h1><p>Describe the website you want and I’ll build an editable draft.</p></div><span class="status-pill status-ready">READY</span></section><div class="assistant-form"><div class="integration-panel"><div class="integration-icon">✳</div><div><h2>What should we build?</h2><p>Tell me about the style, pages, features, and audience. I’ll turn your message into a website draft.</p></div></div><label class="field-label" for="ai-prompt">Your message<textarea id="ai-prompt" rows="5" placeholder="Build a modern bakery website with a seasonal menu, warm colors, opening hours, and an online order button..."></textarea></label><button class="button button-primary" data-action="generate-ai">Build website</button></div>`;
  }

  function renderAdmin() {
    if (adminStatus === "idle" && !session) {
      adminStatus = "denied";
      adminError = auth ? "Sign in with an administrator account to view this page." : "Connect Firebase and sign in before using the administrator panel.";
    }
    const rows = adminUsers.map((user) => `<tr><td><strong>${escapeHtml(user.email || "No email")}</strong><small>${escapeHtml(user.displayName || user.id)}</small></td><td>${new Date(user.createdAt).toLocaleDateString()}</td><td title="${user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : "Never signed in"}">${formatLastActive(user.lastActiveAt)}</td><td><span class="role-pill">${escapeHtml(user.role)}</span></td></tr>`).join("");
    const roleLabel = adminStatus === "ready" ? "ROLE VERIFIED" : adminStatus === "loading" ? "VERIFYING ACCESS" : "PROTECTED";
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">RESTRICTED WORKSPACE</div><h1>Admin</h1><p>Account access and recent activity, from the authenticated user directory.</p></div><span class="status-pill ${adminStatus === "ready" ? "status-ready" : ""}">${roleLabel}</span></section>${adminStatus === "denied" ? `<div class="integration-panel"><div class="integration-icon">⌑</div><div><h2>Administrator access required</h2><p>${escapeHtml(adminError || "This account does not have the admin role.")}</p></div><span class="status-pill">PROTECTED</span></div>` : adminStatus === "error" ? `<div class="integration-panel"><div class="integration-icon">!</div><div><h2>Could not load the user directory</h2><p>${escapeHtml(adminError)}</p><button class="button button-secondary" data-action="reload-admin">Try again</button></div></div>` : `<div class="admin-metrics"><div><span>Registered accounts</span><strong>${adminStatus === "loading" ? "Loading…" : adminTotal}</strong></div><div><span>Active in the last 30 days</span><strong>${adminStatus === "loading" ? "Loading…" : adminActive}</strong></div><div><span>Directory</span><strong>${adminStatus === "loading" ? "Loading…" : `Page ${adminPage}`}</strong></div></div><form class="admin-search" id="admin-search-form"><input name="search" value="${escapeHtml(adminSearch)}" placeholder="Search by email or name" aria-label="Search users" /><button class="button button-outline" type="submit">Search</button></form><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Account</th><th>Joined</th><th>Last active</th><th>Role</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="admin-empty">${adminStatus === "loading" ? "Loading accounts…" : "No accounts found."}</td></tr>`}</tbody></table></div><div class="admin-pagination"><span>${adminStatus === "loading" ? "Checking access…" : `${adminTotal} matching accounts`}</span><div><button class="button button-small button-outline" data-admin-page="${Math.max(1, adminPage - 1)}" ${adminPage <= 1 || adminStatus === "loading" ? "disabled" : ""}>← Previous</button><button class="button button-small button-outline" data-admin-page="${adminPage + 1}" ${adminPage * 25 >= adminTotal || adminStatus === "loading" ? "disabled" : ""}>Next →</button></div></div>`}`;
    if (adminStatus === "idle" && session) loadAdminUsers();
  }

  function formatLastActive(value) {
    if (!value) return "Never active";
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
    if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} days ago`;
    return new Date(value).toLocaleDateString();
  }

  async function loadAdminUsers() {
    if (!functions || !session) { adminStatus = "denied"; adminError = "Sign in with an administrator account to access this page."; renderAdmin(); return; }
    adminStatus = "loading";
    adminError = "";
    renderAdmin();
    try {
      const response = await httpsCallable(functions, "adminUsers")({ page: adminPage, search: adminSearch });
      adminUsers = response.data.users || [];
      adminTotal = response.data.total || 0;
      adminActive = response.data.activeLast30Days || 0;
      adminStatus = "ready";
    } catch (error) {
      adminStatus = error.code === "functions/permission-denied" || error.code === "functions/unauthenticated" ? "denied" : "error";
      adminError = error.message || "Check the Firebase adminUsers function deployment.";
    }
    renderAdmin();
  }

  function renderAuth() {
    const configured = isFirebaseConfigured();
    content.innerHTML = `<section class="auth-page"><div class="auth-art"><span class="auth-orbit orbit-a"></span><span class="auth-orbit orbit-b"></span><span class="auth-art-label">MAKE ROOM FOR<br />YOUR NEXT IDEA.</span><span class="auth-art-mark">BF</span></div><div class="auth-card"><div class="eyebrow">BUILD FLOW WORKSPACE</div>${session ? `<h1>Your workspace, yours.</h1><p class="auth-description">Signed in as ${escapeHtml(session.email)}.</p><button class="button button-primary full-width" data-view="dashboard">Continue to workspace →</button><button class="button button-outline full-width auth-signout" data-action="logout">Sign out</button>` : `<h1>Good to have you.</h1><p class="auth-description">Sign in or create an account to keep your projects with you.</p>${!configured ? `<div class="config-callout">Add your Firebase web app config in <code>config.js</code>, then enable Email/Password and Google Sign-In in Firebase Authentication.</div>` : ""}<div class="auth-divider"><span>or continue with</span></div><div class="auth-actions"><button class="button button-outline full-width google-login-btn" type="button" data-action="google-signin" ${configured ? "" : "disabled"}>?? Continue with Google</button></div><form id="auth-page-form"><label class="field-label">Email<input type="email" name="email" autocomplete="email" required ${configured ? "" : "disabled"} /></label><label class="field-label">Password<input type="password" name="password" minlength="8" autocomplete="current-password" required ${configured ? "" : "disabled"} /></label><label class="field-label signup-name" hidden>Display name<input type="text" name="display_name" maxlength="80" autocomplete="name" /></label><div class="auth-actions"><button class="button button-primary" type="submit" name="mode" value="login" ${configured ? "" : "disabled"}>Log in</button><button class="button button-outline" type="submit" name="mode" value="signup" ${configured ? "" : "disabled"}>Sign up</button></div><button class="text-button auth-reset" type="button" data-action="reset-auth-password" ${configured ? "" : "disabled"}>Forgot password?</button></form>`}<div class="auth-footnote">${configured ? "Firebase Authentication · Email verification is sent at signup" : "Your editable local drafts remain available without an account."}</div></div></section>`;
  }

  function renderSettings() {
    const config = window.BUILDFLOW_CONFIG || {};
    const configured = isFirebaseConfigured();
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">WORKSPACE PREFERENCES</div><h1>Settings</h1><p>Connect services when you’re ready to move beyond local drafts.</p></div></section><section class="settings-section"><div class="settings-heading"><div><h2>Account & cloud sync</h2><p>Firebase provides authentication and Firestore project storage without a separate Storage service.</p></div><span class="status-pill ${configured ? "status-ready" : ""}">${configured ? "CONFIGURED" : "SETUP NEEDED"}</span></div><div class="setup-steps"><div><span>01</span><p>Create a Firebase project and enable Firestore and Authentication.</p></div><div><span>02</span><p>Register a web app and put its Firebase config in <code>config.js</code>.</p></div><div><span>03</span><p>Deploy <code>firestore.rules</code> from this workspace.</p></div><div><span>04</span><p>Deploy the included Cloud Functions for admin access and server-side AI.</p></div></div>${configured ? `<div class="auth-actions">${session ? `<span>Signed in as ${escapeHtml(session.email)}</span><button class="button button-outline" data-action="logout">Sign out</button>` : `<button class="button button-primary" data-action="login">Sign in / create account</button>`}</div>` : `<div class="config-callout">Firebase is not configured. The editor continues to save local drafts in this browser.</div>`}</section><section class="settings-section"><div class="settings-heading"><div><h2>Publishing</h2><p>Live deployment requires a configured deployment provider and secure server integration.</p></div><span class="status-pill">NOT CONFIGURED</span></div><div class="config-callout">Publishing is unavailable in this workspace. No deployment URL will be shown until a real deployment succeeds.</div></section><section class="settings-section danger-section"><div class="settings-heading"><div><h2>Local workspace data</h2><p>Export a copy of your local projects or clear data stored in this browser.</p></div></div><div class="settings-actions"><button class="button button-outline" data-action="export-data">Export workspace JSON</button><button class="button button-danger-outline" data-action="clear-data">Clear local workspace</button></div></section>`;
  }

  function renderPreview() {
    const project = activeProject();
    if (!project) { setView("projects"); return; }
    if (project.spec.generatedHtml) {
      content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">AI-GENERATED WEBSITE</div><h1>${escapeHtml(project.name)}</h1><p>Custom HTML, CSS, and JavaScript generated from your prompt.</p></div><div class="heading-actions"><button class="button button-outline" data-view="editor">← Back to editor</button><button class="button button-outline" data-action="open-preview">Open tab ↗</button></div></section><div class="preview-frame-wrap"><iframe class="preview-frame" title="${escapeHtml(project.name)} website preview" sandbox="allow-scripts allow-forms" srcdoc="${escapeHtml(project.spec.generatedHtml)}"></iframe></div>`;
      return;
    }
    const page = project.spec.pages[0];
    const sections = page.sections.map((section) => `<section class="preview-section"><small>${escapeHtml(section.type)}</small><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.text || "")}</p>${section.button ? `<a href="#contact">${escapeHtml(section.button)} →</a>` : ""}</section>`).join("");
    const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;background:${escapeHtml(project.spec.theme.background)};color:${escapeHtml(project.spec.theme.foreground)};font:16px 'DM Sans',sans-serif}.nav{height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 8%;border-bottom:1px solid #0001}.nav b{font-size:19px}.nav span{font-size:13px}.hero{padding:110px 12% 92px;background:linear-gradient(145deg,${escapeHtml(project.spec.theme.background)},${escapeHtml(project.spec.theme.accent)}22)}.preview-section{padding:70px 12%;border-bottom:1px solid #0001}.preview-section small{color:${escapeHtml(project.spec.theme.accent)};text-transform:uppercase;letter-spacing:1px}.preview-section h1,.preview-section h2{font-size:clamp(32px,6vw,68px);line-height:1.05;max-width:760px;margin:18px 0}.preview-section p{max-width:560px;line-height:1.7;opacity:.72}.preview-section a{display:inline-block;background:${escapeHtml(project.spec.theme.accent)};color:white;padding:14px 20px;text-decoration:none;margin-top:14px}.footer{padding:34px 12%;font-size:13px;opacity:.7}</style></head><body><header class="nav"><b>${escapeHtml(project.name)}</b><span>About　 Services　 Contact</span></header><main class="hero">${sections}</main><footer class="footer">${escapeHtml(project.name)} · Thoughtfully made.</footer></body></html>`;
    content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">PREVIEW</div><h1>${escapeHtml(project.name)}</h1><p>Isolated preview, rendered from your structured project content.</p></div><div class="heading-actions"><button class="button button-outline" data-view="editor">← Back to editor</button><button class="button button-outline" data-action="open-preview">Open tab ↗</button></div></section><div class="preview-frame-wrap"><iframe class="preview-frame" title="${escapeHtml(project.name)} website preview" sandbox="" srcdoc="${escapeHtml(documentHtml)}"></iframe></div>`;
  }

  function openModal(markup) {
    $("#modal-content").innerHTML = markup;
    $("#modal-backdrop").hidden = false;
    $("#modal-close").focus();
  }
  function closeModal() { $("#modal-backdrop").hidden = true; }

  function newProjectModal(initialPrompt = "") {
    openModal(`<div class="eyebrow">A FRESH CANVAS</div><h2 id="modal-title">Start a project</h2><p class="modal-description">Create a blank editable draft. Use the AI assistant for real prompt-based website generation.</p><form id="new-project-form"><label class="field-label">Project name<input name="name" placeholder="e.g. Vero Coffee" required maxlength="60" /></label><label class="field-label">What are you building?<textarea name="prompt" rows="4" placeholder="A welcoming coffee shop with a menu, location, and story..." required maxlength="1000">${escapeHtml(initialPrompt)}</textarea></label><label class="field-label">Starting point<select name="category"><option>Studio</option><option>Portfolio</option><option>Restaurant</option><option>SaaS</option><option>Agency</option><option>Barber</option><option>Fitness</option></select></label><p class="form-note">This is a local editable draft. For AI-generated websites, open the AI assistant and add your API key.</p><button class="button button-primary full-width" type="submit">Create editable draft →</button></form>`);
  }

  function createFromTemplate(index) {
    const template = templateData[index];
    if (!template) return;
    const project = createProject(template.name, template.description, template.category);
    project.spec.theme.background = template.colors[0];
    project.spec.theme.accent = template.colors[1];
    project.spec.pages[0].sections[0].title = template.name;
    project.spec.pages[0].sections[0].text = template.description;
    persist();
    setView("editor");
    toast("Template draft created.");
  }

  function saveVersion() {
    const project = activeProject();
    if (!project) return;
    addVersion(project, "Manual save");
    persist();
    toast("Version saved.");
    if (currentView === "editor") renderEditor();
    if (currentView === "versions") renderVersions();
  }

  function restoreVersion(id) {
    const project = activeProject();
    const version = project?.versions.find((item) => item.id === id);
    if (!project || !version) return;
    addVersion(project, "Before restore");
    project.spec = JSON.parse(JSON.stringify(version.spec));
    addVersion(project, `Restored: ${version.label}`);
    persist(); renderVersions(); toast("Version restored. Your previous draft was kept as a new version.");
  }

  function timestampToIso(value, fallback = new Date().toISOString()) {
    if (!value) return fallback;
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  async function initializeFirebase() {
    if (!isFirebaseConfigured()) return;
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
    functions = getFunctions(firebaseApp, firebaseConfig.functionsRegion || "us-central1");
    currentView = "auth";
    onAuthStateChanged(auth, async (user) => {
      session = user;
      adminStatus = "idle";
      adminUsers = [];
      updateChrome();
      if (session) {
        state.localProjects = [...(state.localProjects || []), ...state.projects.filter((project) => project.origin !== "remote")];
        state.localProjects = [...new Map(state.localProjects.map((project) => [project.id, project])).values()];
        state.localAssets = [...new Map(state.localAssets.map((asset) => [asset.id || asset.name, asset])).values()];
        state.projects = [];
        state.assets = [];
        currentView = session.emailVerified ? "dashboard" : "auth";
        const tasks = [loadRemoteProjects(), refreshOwnRole()];
        if (session.emailVerified) tasks.push(touchLastActive());
        await Promise.all(tasks);
      } else {
        isAdmin = false;
        state.projects = [...(state.localProjects || []), ...state.projects.filter((project) => project.origin !== "remote")];
        state.assets = [...(state.localAssets || [])];
        currentView = "auth";
        updateChrome();
        render();
      }
    });
  }

  async function touchLastActive() {
    if (!functions || !session || document.hidden) return;
    try { await httpsCallable(functions, "touchLastActive")(); }
    catch (error) { console.warn("Could not update account activity:", error.message); }
  }

  async function refreshOwnRole() {
    if (!db || !session) { isAdmin = false; updateChrome(); return; }
    const userId = session.uid;
    try {
      const profile = await getDoc(doc(db, "profiles", userId));
      if (session?.uid !== userId) return;
      isAdmin = profile.exists() && profile.data().role === "admin";
    } catch { isAdmin = false; }
    updateChrome();
    if (currentView === "admin" && !isAdmin) { adminStatus = "denied"; adminError = "This account does not have the admin role."; renderAdmin(); }
  }

  async function loadRemoteProjects() {
    if (!db || !session) return;
    try {
      const snapshot = await getDocs(query(collection(db, "projects"), where("ownerId", "==", session.uid)));
      const remote = snapshot.docs.map((projectDoc) => {
        const row = projectDoc.data();
        return { id: projectDoc.id, name: row.name, spec: row.spec, updatedAt: timestampToIso(row.updatedAt), createdAt: timestampToIso(row.createdAt), versions: row.versions || [], status: "Draft", origin: "remote", framework: "HTML, CSS & JS" };
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const localDrafts = [...(state.localProjects || []), ...state.projects.filter((project) => project.origin !== "remote")];
    state.localProjects = [...new Map(localDrafts.map((project) => [project.id, project])).values()];
    state.projects = remote;
    state.activeId = remote[0]?.id || null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateChrome(); render();
    } catch (error) { toast(`Could not load Firebase projects: ${error.message}`, "error"); }
  }

  async function syncActiveProject() {
    const project = activeProject();
    if (!project || !db || !session || project._syncing) return;
    clearTimeout(saveTimer);
    project._syncing = true;
    saveTimer = setTimeout(async () => {
      try {
        const existing = project.origin === "remote";
          const projectData = {
          ownerId: session.uid,
          name: project.name,
          spec: project.spec,
          updatedAt: serverTimestamp(),
          versions: project.versions || [],
          };
          if (!existing) projectData.createdAt = serverTimestamp();
          await setDoc(doc(db, "projects", project.id), projectData, { merge: true });
        project.origin = "remote";
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch { toast("Firebase save failed. Your browser copy is still available.", "error"); }
      finally { project._syncing = false; }
    }, 800);
  }

  async function ensureProfileDocument(user) {
    if (!db || !user) return;
    const profileRef = doc(db, "profiles", user.uid);
    const current = await getDoc(profileRef).catch(() => null);
    if (!current || !current.exists()) {
      await setDoc(profileRef, {
        email: user.email || "",
        emailNormalized: (user.email || "").toLowerCase(),
        displayName: user.displayName || "",
        role: "user",
        plan: "FREE",
        createdAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
      }, { merge: true });
    }
  }

  async function signInWithGoogle() {
    if (!auth || !isFirebaseConfigured()) {
      toast("Firebase must be configured before Google sign in is available.", "error");
      setView("settings");
      return;
    }
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const credential = await signInWithPopup(auth, provider);
      await ensureProfileDocument(credential.user);
      session = credential.user;
      currentView = "dashboard";
      await touchLastActive();
      render();
      toast("Signed in with Google.");
    } catch (error) {
      toast(error.message || "Google sign in could not complete.", "error");
    }
  }

  async function authenticate() {
    if (session) { await signOut(auth); toast("Signed out."); }
    else setView("auth");
  }

  async function submitAuth(form, mode) {
    const values = new FormData(form);
    const email = String(values.get("email"));
    const password = String(values.get("password"));
    const displayName = String(values.get("display_name") || "").trim();
    try {
      const credential = mode === "signup"
        ? await createUserWithEmailAndPassword(auth, email, password)
        : await signInWithEmailAndPassword(auth, email, password);
      if (mode === "signup") {
        if (displayName) await updateProfile(credential.user, { displayName });
        await setDoc(doc(db, "profiles", credential.user.uid), {
          email: credential.user.email,
          emailNormalized: credential.user.email.toLowerCase(),
          displayName: credential.user.displayName || "",
          role: "user",
          plan: "FREE",
          createdAt: serverTimestamp(),
          lastActiveAt: serverTimestamp(),
        });
        await sendEmailVerification(credential.user);
        await signOut(auth);
        render();
        toast("Check your email to verify your account, then log in.");
        return;
      }
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        render();
        toast("Verify your email using the link we sent before logging in.", "error");
        return;
      }
      session = credential.user;
      currentView = "dashboard";
      await touchLastActive();
      render();
      toast("Signed in.");
    } catch (error) { toast(error.message || "Authentication failed.", "error"); }
  }

  async function generateWithAI(promptOverride = "") {
    const prompt = promptOverride || $("#ai-prompt")?.value.trim();
    const apiKey = GROQ_API_KEY;
    if (!apiKey) { toast("The AI key is not configured in app.js.", "error"); return; }
    if (!prompt) { toast("Add a short description first.", "error"); return; }
    toast("Generating your website from the prompt…");
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            max_completion_tokens: 6000,
          messages: [
              { role: "system", content: "You are an expert web designer and front-end developer. Build a genuinely custom, polished, responsive website based on the user's exact brief. Return only a complete standalone HTML document, from <!doctype html> through </html>, with all CSS in a style element and any needed JavaScript in a script element. Do not return JSON, markdown fences, explanations, templates, or placeholder copy. Create a distinctive layout, typography, colors, navigation, sections, and interactions suited to this specific brief. Include real copy relevant to the business and working client-side interactions. Use no frameworks, build tools, or external JavaScript libraries. Keep the code concise enough to fit in the response."
              },
              { role: "user", content: `Create the complete website now. Follow this brief closely:\n\n${prompt}` }
          ],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data?.error?.message || "Groq rejected the request.";
        throw new Error(message);
      }
      const raw = data?.choices?.[0]?.message?.content || "";
      const generatedHtml = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
      if (!/<html[\s>]/i.test(generatedHtml) || !/<body[\s>]/i.test(generatedHtml) || !/<\/html\s*>/i.test(generatedHtml)) {
        throw new Error("The AI response was incomplete. Try again with a shorter or more specific request.");
      }
      const parsedDocument = new DOMParser().parseFromString(generatedHtml, "text/html");
      const projectName = parsedDocument.title.trim() || prompt.split(/\s+/).slice(0, 4).join(" ");
      const project = createProject(projectName, prompt, "AI generated");
      project.spec = {
        name: projectName,
        description: prompt,
        theme: { background: "#ffffff", foreground: "#111111", accent: "#297455", font: "Generated" },
        pages: [{ name: "Home", slug: "/", sections: [] }],
        generatedHtml,
      };
      addVersion(project, "AI generation from browser");
      persist(); setView("editor"); toast("AI website draft created.");
    } catch (error) {
      toast(error.message || "The AI request could not complete. Check your API key or network connection.", "error");
    }
  }

  function openProject(id) {
    state.activeId = id;
    const project = activeProject();
    if (!project) return;
    setView("editor");
  }

  document.addEventListener("click", async (event) => {
    const canvasSection = event.target.closest("[data-canvas-section]");
    if (canvasSection) { selectedSection = Number(canvasSection.dataset.canvasSection); renderEditor(); return; }
    const target = event.target.closest("button");
    if (!target) return;
    if (target.name === "mode" && currentView === "auth") { const nameField = $(".signup-name"); if (nameField) nameField.hidden = target.value !== "signup"; return; }
    if (target.dataset.view) { setView(target.dataset.view); return; }
    if (target.dataset.action === "new-project") { newProjectModal(); return; }
    if (target.dataset.action === "upload-asset") { $("#asset-input").click(); return; }
    if (target.dataset.action === "save-version") { saveVersion(); return; }
    if (target.dataset.action === "generate-ai") { await generateWithAI(); return; }
    if (target.dataset.action === "google-signin") { await signInWithGoogle(); return; }
    if (target.dataset.action === "login") { if (auth) await authenticate(); else { setView("auth"); toast("Add Firebase web app settings in config.js first.", "error"); } return; }
    if (target.dataset.action === "logout") { await authenticate(); return; }
    if (target.dataset.action === "reload-admin") { adminStatus = "idle"; await loadAdminUsers(); return; }
    if (target.dataset.adminPage) { adminPage = Number(target.dataset.adminPage); adminStatus = "idle"; await loadAdminUsers(); return; }
    if (target.dataset.action === "reset-auth-password") { const email = $("#auth-page-form [name=email]").value.trim(); if (!email) { toast("Enter your email first.", "error"); return; } try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent."); } catch (error) { toast(error.message, "error"); } return; }
    if (target.dataset.action === "reset-password") { const email = $("#auth-form [name=email]").value; if (!email) { toast("Enter your email first.", "error"); return; } try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent."); } catch (error) { toast(error.message, "error"); } return; }
    if (target.dataset.action === "add-section") { const project = activeProject(); project.spec.pages[0].sections.push({ type: "features", title: "A new section", text: "Add a little detail to make this yours.", button: "Learn more" }); checkpoint(project); selectedSection = project.spec.pages[0].sections.length - 1; addVersion(project, "Section added"); persist(); renderEditor(); return; }
    if (target.dataset.action === "delete-section") { const project = activeProject(); if (project.spec.pages[0].sections.length <= 1) { toast("A page needs at least one section.", "error"); return; } project.spec.pages[0].sections.splice(selectedSection, 1); checkpoint(project); selectedSection = Math.max(0, selectedSection - 1); addVersion(project, "Section removed"); persist(); renderEditor(); toast("Section removed."); return; }
    if (target.dataset.action === "undo" || target.dataset.action === "redo") { changeHistory(target.dataset.action); return; }
    if (target.dataset.action === "open-preview") { const frame = $(".preview-frame"); if (frame) window.open(`data:text/html;charset=utf-8,${encodeURIComponent(frame.srcdoc)}`, "_blank", "noopener"); return; }
    if (target.dataset.action === "export-data") { const blob = new Blob([JSON.stringify({ projects: state.projects, localProjects: state.localProjects || [], assets: state.assets }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "buildflow-workspace.json"; link.click(); URL.revokeObjectURL(link.href); return; }
    if (target.dataset.action === "clear-data") { if (confirm("Delete all projects and assets stored in this browser? This cannot be undone.")) { state = blankState(); persist(); setView("dashboard"); toast("Local workspace cleared."); } return; }
    if (target.dataset.action === "project-delete") { const id = target.dataset.id; const project = state.projects.find((item) => item.id === id); if (project && confirm(`Delete “${project.name}” from ${project.origin === "remote" ? "Firebase" : "this browser"}?`)) { if (project.origin === "remote" && db) { try { await deleteDoc(doc(db, "projects", id)); } catch (error) { toast(`Project could not be deleted: ${error.message}`, "error"); return; } } state.projects = state.projects.filter((item) => item.id !== id); if (state.activeId === id) state.activeId = null; persist(); render(); toast("Project deleted."); } return; }
    if (target.dataset.openProject) { openProject(target.dataset.openProject); return; }
    if (target.dataset.projectMenu) { const project = state.projects.find((item) => item.id === target.dataset.projectMenu); openModal(`<div class="eyebrow">PROJECT OPTIONS</div><h2 id="modal-title">${escapeHtml(project.name)}</h2><p class="modal-description">Saved in ${project.origin === "remote" ? "your Firebase account" : "this browser"}.</p><div class="modal-actions"><button class="button button-primary" data-open-project="${project.id}">Open editor</button><button class="button button-danger-outline" data-action="project-delete" data-id="${project.id}">Delete project</button></div>`); return; }
    if (target.dataset.useTemplate) { createFromTemplate(Number(target.dataset.useTemplate)); return; }
    if (target.dataset.selectSection !== undefined) { selectedSection = Number(target.dataset.selectSection); renderEditor(); return; }
    if (target.dataset.width) { previewWidth = target.dataset.width; renderEditor(); return; }
    if (target.dataset.restoreVersion) { if (confirm("Restore this version? Your current draft will be kept as a new version.")) restoreVersion(target.dataset.restoreVersion); return; }
    if (target.dataset.deleteAsset !== undefined) { const asset = state.assets[Number(target.dataset.deleteAsset)]; state.localAssets = (state.localAssets || []).filter((item) => item !== asset); state.assets.splice(Number(target.dataset.deleteAsset), 1); persist(); renderAssets(); toast("Image removed."); return; }
    if (target.dataset.prompt) { newProjectModal(target.dataset.prompt); return; }
  });

  content.addEventListener("dragstart", (event) => {
    const layer = event.target.closest(".layer-item");
    if (!layer) return;
    event.dataTransfer.setData("text/plain", layer.dataset.dragIndex);
    event.dataTransfer.effectAllowed = "move";
  });
  content.addEventListener("dragover", (event) => { if (event.target.closest(".layer-item")) event.preventDefault(); });
  content.addEventListener("drop", (event) => {
    const target = event.target.closest(".layer-item");
    if (!target) return;
    event.preventDefault();
    const from = Number(event.dataTransfer.getData("text/plain"));
    const to = Number(target.dataset.dragIndex);
    const project = activeProject();
    const sections = project?.spec.pages[0].sections;
    if (!sections || !Number.isInteger(from) || from === to || from < 0 || from >= sections.length) return;
    sections.splice(to, 0, sections.splice(from, 1)[0]);
    checkpoint(project);
    selectedSection = to;
    persist();
    renderEditor();
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id === "quickstart-form") {
      event.preventDefault();
      const prompt = String(new FormData(event.target).get("prompt") || "").trim();
      await generateWithAI(prompt);
    }
    if (event.target.id === "new-project-form") {
      event.preventDefault(); const values = new FormData(event.target);
      const project = createProject(String(values.get("name")), String(values.get("prompt")), String(values.get("category")));
      closeModal(); setView("editor"); toast("Editable draft created and saved in this browser.");
      if (auth && session) syncActiveProject();
    }
    if (event.target.id === "auth-form") {
      event.preventDefault(); const submitter = event.submitter;
      await submitAuth(event.target, submitter?.value || "login");
    }
    if (event.target.id === "auth-page-form") {
      event.preventDefault();
      await submitAuth(event.target, event.submitter?.value || "login");
    }
    if (event.target.id === "admin-search-form") {
      event.preventDefault();
      adminSearch = String(new FormData(event.target).get("search") || "").trim();
      adminPage = 1;
      adminStatus = "idle";
      await loadAdminUsers();
    }
  });

  $("#asset-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type) || file.size > LIMITS.assetBytes) { toast("Choose a JPG, PNG, WebP, or GIF image under 3 MB.", "error"); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => { const asset = { id: crypto.randomUUID(), name: file.name, size: file.size, data: reader.result, createdAt: new Date().toISOString() }; state.localAssets ||= []; state.localAssets.unshift(asset); state.assets.unshift(asset); try { persist(); renderAssets(); toast("Image added to your local library."); } catch { toast("The image could not be saved. Try a smaller file.", "error"); } };
    reader.readAsDataURL(file);
    event.target.value = "";
  });

  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("click", (event) => { if (event.target.id === "modal-backdrop") closeModal(); });
  $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("sidebar-open"));
  $("#search-button").addEventListener("click", () => { setView("projects"); $("#project-search")?.focus(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveVersion(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) touchLastActive(); });
  setInterval(() => { if (!document.hidden) touchLastActive(); }, 300_000);

  initializeFirebase().catch((error) => { console.error("Firebase initialization failed:", error); toast("Firebase could not initialize. Check your web app config.", "error"); }).finally(() => { updateChrome(); render(); });
  document.addEventListener("click", (event) => { if (event.target.closest("#property-title, #property-text, #property-button")) bindEditorInputs(); });
  const observer = new MutationObserver(() => { if (currentView === "editor") bindEditorInputs(); });
  observer.observe(content, { childList: true });
})();