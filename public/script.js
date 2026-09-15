"use strict";

const IPK = window.IPK;
let currentUser = IPK?.getUser() || null;
let currentChatUser = null;
let socket = null;
let friendsCache = [];
let messagesRequest = 0;
let removeTargetId = null;
let lastFocusedElement = null;
let typingStopTimer = null;
let draftTimer = null;
const onlineUsers = new Set();
const lastSeenMap = new Map();
const typingInChatList = new Set();
let unreadTotal = 0;
let originalTitle = "ИПК — свой круг";
let soundEnabled = localStorage.getItem("ipk_sound") !== "off";
let soundContext = null;

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const toast = $("toast");
const sidebar = $("sidebar");
const chatList = $("chatList");
const searchInput = $("searchInput");
const refreshButton = $("refreshButton");
const welcomeScreen = $("welcomeScreen");
const chatScreen = $("chatScreen");
const chatAvatar = $("chatAvatar");
const chatName = $("chatName");
const chatStatus = $("chatStatus");
const chatPresenceDot = $("chatPresenceDot");
const messages = $("messages");
const messageForm = $("messageForm");
const messageInput = $("messageInput");
const sendButton = $("sendButton");
const emojiButton = $("emojiButton");
const emojiPicker = $("emojiPicker");
const attachButton = $("attachButton");
const fileInput = $("fileInput");
const typingRow = $("typingRow");
const typingText = $("typingText");
const connectionPill = $("connectionPill");
const draftStatus = $("draftStatus");
const mobileBackButton = $("mobileBackButton");
const chatSearchButton = $("chatSearchButton");
const chatSearch = $("chatSearch");
const chatSearchInput = $("chatSearchInput");
const chatSearchCount = $("chatSearchCount");
const closeChatSearch = $("closeChatSearch");

const themeOverlay = $("themeOverlay");
const friendOverlay = $("friendOverlay");
const profileOverlay = $("profileOverlay");
const confirmOverlay = $("confirmOverlay");
const usernameInput = $("usernameInput");
const saveProfileButton = $("saveProfile");

const emojis = ["😀", "😄", "😂", "😊", "😍", "🥰", "😎", "🤝", "👍", "👏", "🔥", "❤️", "💜", "✨", "🎉", "🚀", "💯", "🤔", "👀", "😮", "😭", "😅", "🙌", "🙏", "💪", "☕", "🌙", "⚡"];

function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function getInitial(username) {
    return String(username || "?").trim().charAt(0).toUpperCase() || "?";
}

/* --- Last seen formatting --- */
function formatLastSeen(value) {
    if (!value) return "не в сети";
    const date = parseServerDate(value);
    if (Number.isNaN(date.getTime())) return "не в сети";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "был(а) только что";
    if (diffMin < 60) return `был(а) ${diffMin} мин назад`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) {
        const today = new Date();
        if (date.toDateString() === today.toDateString()) {
            return `был(а) в ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
        }
    }
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "был(а) вчера";
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `был(а) ${diffDays} дн назад`;
    return `был(а) ${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
}

function getPresenceText(userId) {
    if (onlineUsers.has(Number(userId))) return "сейчас в сети";
    return formatLastSeen(lastSeenMap.get(Number(userId)));
}

/* --- Sound notification --- */
function playNotificationSound() {
    if (!soundEnabled) return;
    try {
        if (!soundContext) soundContext = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = soundContext;
        if (ctx.state === "suspended") ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        // AudioContext not available — silent fallback
    }
}

/* --- Tab title notifications --- */
function updateTabTitle() {
    if (unreadTotal > 0) {
        document.title = `(${unreadTotal}) ${originalTitle}`;
    } else {
        document.title = originalTitle;
    }
}

window.addEventListener("focus", () => {
    if (currentChatUser) {
        // Clear unread for current chat
        const friend = friendsCache.find((f) => Number(f.id) === Number(currentChatUser.id));
        if (friend) friend.unread_count = 0;
    }
    recountUnread();
});

function recountUnread() {
    const count = friendsCache.reduce((sum, f) => sum + (Number(f.unread_count) || 0), 0);
    unreadTotal = count;
    updateTabTitle();
}

function showToast(title, text = "") {
    if (!toast) return;
    toast.innerHTML = `<strong>${escapeHTML(title)}</strong>${text ? `<span>${escapeHTML(text)}</span>` : ""}`;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function openModal(overlay, focusTarget) {
    if (!overlay) return;
    lastFocusedElement = document.activeElement;
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    setTimeout(() => (focusTarget || overlay.querySelector("button, input"))?.focus(), 40);
}

function closeModal(overlay) {
    if (!overlay || overlay.classList.contains("hidden")) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".modal-overlay:not(.hidden)")) document.body.classList.remove("modal-open");
    lastFocusedElement?.focus?.();
}

[themeOverlay, friendOverlay, profileOverlay, confirmOverlay].forEach((overlay) => {
    overlay?.addEventListener("mousedown", (event) => {
        if (event.target === overlay) closeModal(overlay);
    });
});

$("closeTheme")?.addEventListener("click", () => closeModal(themeOverlay));
$("closeFriend")?.addEventListener("click", () => closeModal(friendOverlay));
$("closeProfile")?.addEventListener("click", () => closeModal(profileOverlay));
$("confirmCancel")?.addEventListener("click", () => closeModal(confirmOverlay));

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const opened = [...document.querySelectorAll(".modal-overlay:not(.hidden)")].pop();
    if (opened) return closeModal(opened);
    if (!emojiPicker.classList.contains("hidden")) return toggleEmojiPicker(false);
    if (!chatSearch.classList.contains("hidden")) return toggleChatSearch(false);
    if (window.innerWidth <= 680 && appEl.classList.contains("mobile-chat-open")) closeMobileChat();
});

/* Theme */
/**
 * Список допустимых тем берём из разметки, а не из жёсткого перечня.
 * Раньше здесь стоял массив из четырёх тем, и любую новую он молча откатывал
 * к midnight — при этом всплывало «Оформление изменено», то есть человек
 * получал ложное подтверждение. Теперь достаточно добавить карточку в разметку.
 */
function allowedThemes() {
    const fromMarkup = [...document.querySelectorAll(".theme-card")]
        .map((card) => card.dataset.theme)
        .filter(Boolean);
    return fromMarkup.length ? fromMarkup : ["midnight"];
}

// Цвет адресной строки в мобильном браузере — под фон темы.
const THEME_COLORS = {
    midnight: "#080b12", violet: "#0d0812", ocean: "#061015", light: "#eef1f7",
    sunset: "#150b12", forest: "#071310", rose: "#140b10", sand: "#f6f1e8"
};

function applyTheme(theme = "midnight") {
    const allowed = allowedThemes();
    const selected = allowed.includes(theme) ? theme : "midnight";
    document.body.dataset.theme = selected;
    localStorage.setItem("ipk_theme", selected);
    document.querySelectorAll(".theme-card").forEach((card) => card.classList.toggle("active", card.dataset.theme === selected));
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[selected] || "#080b12");
}

applyTheme(localStorage.getItem("ipk_theme") || "midnight");
$("themeButton")?.addEventListener("click", () => openModal(themeOverlay));
document.querySelectorAll(".theme-card").forEach((card) => card.addEventListener("click", () => {
    applyTheme(card.dataset.theme);
    showToast("Оформление изменено", "Тема сохранена на этом устройстве");
    setTimeout(() => closeModal(themeOverlay), 180);
}));

/* Sound toggle */
const soundToggle = $("soundToggle");
function updateSoundIcon() {
    if (soundToggle) {
        soundToggle.textContent = soundEnabled ? "🔊" : "🔇";
        soundToggle.setAttribute("aria-label", soundEnabled ? "Выключить звук" : "Включить звук");
        soundToggle.title = soundEnabled ? "Звук включён" : "Звук выключен";
    }
}
updateSoundIcon();
soundToggle?.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("ipk_sound", soundEnabled ? "on" : "off");
    updateSoundIcon();
    if (soundEnabled) playNotificationSound();
    showToast("Звук уведомлений", soundEnabled ? "Включён" : "Выключен");
});

/* Profile */
function updateUserUI() {
    if (!currentUser) return;
    $("currentNickname").textContent = currentUser.username;
    $("userAvatar").textContent = getInitial(currentUser.username);
    $("profileAvatar").textContent = getInitial(currentUser.username);
    document.querySelectorAll("[data-current-username]").forEach((element) => element.textContent = currentUser.username);
}

function openProfile() {
    if (!currentUser) return;
    usernameInput.value = currentUser.username;
    openModal(profileOverlay, usernameInput);
    setTimeout(() => usernameInput.select(), 60);
}

$("profileButton")?.addEventListener("click", openProfile);
$("profileSummaryButton")?.addEventListener("click", openProfile);
usernameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveProfileButton.click();
});

saveProfileButton?.addEventListener("click", async () => {
    const username = usernameInput.value.trim();
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]{3,24}$/.test(username)) {
        showToast("Проверь никнейм", "Нужно 3–24 символа: буквы, цифры и _");
        return;
    }
    saveProfileButton.disabled = true;
    try {
        const data = await IPK.api("/api/profile", { method: "PUT", body: { username } });
        currentUser = data.user;
        IPK.saveUser(currentUser);
        updateUserUI();
        closeModal(profileOverlay);
        showToast("Профиль обновлён", `Теперь ты @${currentUser.username}`);
    } catch (error) {
        showToast("Не удалось сохранить", error.message);
    } finally {
        saveProfileButton.disabled = false;
    }
});

/* Friends */
function openFriends() {
    openModal(friendOverlay, $("friendSearchInput"));
    refreshFriends();
}

$("addFriendButton")?.addEventListener("click", openFriends);
$("welcomeAddFriend")?.addEventListener("click", openFriends);
$("friendSearchButton")?.addEventListener("click", searchUsers);
$("friendSearchInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchUsers();
});

async function searchUsers() {
    const input = $("friendSearchInput");
    const results = $("friendSearchResults");
    const query = input.value.trim();
    if (query.length < 2) {
        results.innerHTML = '<div class="friend-hint">Введи хотя бы 2 символа никнейма</div>';
        return;
    }
    results.innerHTML = '<div class="friend-loading">Ищем в закрытом круге…</div>';
    try {
        const data = await IPK.api(`/api/users/search?q=${encodeURIComponent(query)}`);
        if (!data.users?.length) {
            results.innerHTML = '<div class="friend-empty"><div>⌁</div>Никого не нашли. Проверь написание.</div>';
            return;
        }
        results.innerHTML = `<div class="friend-section-title">Результаты</div>${data.users.map(searchUserHTML).join("")}`;
        results.querySelectorAll("[data-friend-request]").forEach((button) => button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                await IPK.api("/api/friends/request", { method: "POST", body: { userId: Number(button.dataset.friendRequest) } });
                button.textContent = "Отправлено";
                showToast("Заявка отправлена", "Друг увидит её сразу");
            } catch (error) {
                button.disabled = false;
                showToast("Не получилось", error.message);
            }
        }));
    } catch (error) {
        results.innerHTML = `<div class="friend-empty"><div>!</div>${escapeHTML(error.message)}</div>`;
    }
}

function searchUserHTML(user) {
    const relation = user.relation || "none";
    const labels = { friend: "Уже в друзьях", sent: "Заявка отправлена", received: "Ответь ниже" };
    const disabled = relation !== "none";
    return `<div class="friend-item">
        <div class="friend-avatar-wrap"><span class="avatar friend-avatar">${escapeHTML(getInitial(user.username))}</span></div>
        <div class="friend-info"><div class="friend-name">@${escapeHTML(user.username)}</div><div class="friend-online">${labels[relation] || "Можно добавить в друзья"}</div></div>
        <div class="friend-actions"><button type="button" data-friend-request="${Number(user.id)}" ${disabled ? "disabled" : ""}>${disabled ? labels[relation] : "Добавить"}</button></div>
    </div>`;
}

async function refreshFriends(options = {}) {
    if (!IPK.getToken()) return;
    if (refreshButton) refreshButton.disabled = true;
    try {
        const [friendsData, requestsData] = await Promise.all([
            IPK.api("/api/friends"),
            IPK.api("/api/friends/requests")
        ]);
        friendsCache = friendsData.friends || [];
        friendsCache.forEach((f) => { if (f.last_seen) lastSeenMap.set(Number(f.id), f.last_seen); });
        renderSidebarFriends(friendsCache);
        renderFriendList(friendsCache);
        renderFriendRequests(requestsData.requests || []);
        if (currentChatUser) {
            const updated = friendsCache.find((friend) => Number(friend.id) === Number(currentChatUser.id));
            if (updated) currentChatUser = { ...currentChatUser, ...updated };
        }
        recountUnread();
        // Сервер сообщает «друг в сети» только при его первом подключении.
        // Поэтому после каждого обновления списка спрашиваем актуальный статус —
        // иначе новый друг, который уже был онлайн, выглядел как «не в сети».
        if (socket?.connected) socket.emit("presence:get");
        if (options.toast) showToast("Готово", "Список обновлён");
    } catch (error) {
        if (IPK.getToken()) showToast("Не удалось обновить", error.message);
        renderSidebarError(error.message);
    } finally {
        if (refreshButton) refreshButton.disabled = false;
    }
}

refreshButton?.addEventListener("click", () => refreshFriends({ toast: true }));

function renderSidebarFriends(friends) {
    if (!friends.length) {
        chatList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">+</div><h3>Твой круг пока пуст</h3><p>Добавь друга по никнейму — и здесь появится первый диалог.</p></div>';
        return;
    }
    chatList.innerHTML = friends.map((user, index) => {
        const online = onlineUsers.has(Number(user.id));
        const active = Number(currentChatUser?.id) === Number(user.id);
        const isTyping = typingInChatList.has(Number(user.id));
        const preview = isTyping
            ? `<span class="chat-preview typing-preview">печатает…</span>`
            : `<span class="chat-preview">${escapeHTML(user.last_message || (online ? "сейчас в сети" : formatLastSeen(user.last_seen)))}</span>`;
        const statusText = isTyping ? "печатает…" : (online ? "сейчас в сети" : formatLastSeen(user.last_seen));
        return `<button class="chat-list-item ${active ? "active" : ""}" style="animation-delay:${Math.min(index * 35, 210)}ms" type="button" data-sidebar-user="${Number(user.id)}" title="${escapeHTML(statusText)}">
            <span class="chat-list-avatar"><span class="avatar">${escapeHTML(getInitial(user.username))}</span><i class="presence-dot ${online ? "online" : ""}"></i></span>
            <span class="chat-list-copy"><span class="chat-list-top"><b class="chat-list-name">${escapeHTML(user.username)}</b><small class="chat-list-time">${escapeHTML(formatSidebarTime(user.last_message_at))}</small></span><span class="chat-list-bottom">${preview}${user.unread_count ? `<span class="unread-badge">${Math.min(Number(user.unread_count), 99)}</span>` : ""}</span></span>
        </button>`;
    }).join("");
    chatList.querySelectorAll("[data-sidebar-user]").forEach((button) => button.addEventListener("click", () => {
        const user = friendsCache.find((item) => Number(item.id) === Number(button.dataset.sidebarUser));
        if (user) openChat(user);
    }));
    applySidebarSearch();
}

function renderSidebarError(message) {
    chatList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">!</div><h3>Нет связи с сервером</h3><p>${escapeHTML(message)}</p></div>`;
}

function renderFriendRequests(requests) {
    const box = $("friendRequests");
    if (!requests.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="friend-section-title">Входящие · ${requests.length}</div>${requests.map((request) => `<div class="friend-item"><div class="friend-avatar-wrap"><span class="avatar friend-avatar">${escapeHTML(getInitial(request.username))}</span></div><div class="friend-info"><div class="friend-name">@${escapeHTML(request.username)}</div><div class="friend-online">Хочет добавить тебя в друзья</div></div><div class="friend-actions"><button class="accept-button" type="button" data-accept="${Number(request.id)}" aria-label="Принять заявку">Принять</button><button class="reject-button" type="button" data-reject="${Number(request.id)}" aria-label="Отклонить заявку">×</button></div></div>`).join("")}`;
    box.querySelectorAll("[data-accept]").forEach((button) => button.addEventListener("click", () => handleFriendRequest("accept", Number(button.dataset.accept), button)));
    box.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => handleFriendRequest("reject", Number(button.dataset.reject), button)));
}

async function handleFriendRequest(action, requestId, button) {
    button.disabled = true;
    try {
        await IPK.api(`/api/friends/${action}`, { method: "POST", body: { requestId } });
        showToast(action === "accept" ? "Вы теперь друзья" : "Заявка отклонена", action === "accept" ? "Диалог появился в списке" : "");
        await refreshFriends();
    } catch (error) {
        button.disabled = false;
        showToast("Не получилось", error.message);
    }
}

function renderFriendList(friends) {
    const box = $("friendListModal");
    if (!friends.length) {
        box.innerHTML = '<div class="friend-section-title">Друзья</div><div class="friend-empty"><div>◎</div>Здесь появятся принятые друзья.</div>';
        return;
    }
    box.innerHTML = `<div class="friend-section-title">Друзья · ${friends.length}</div>${friends.map((user) => {
        const online = onlineUsers.has(Number(user.id));
        const presenceText = online ? "сейчас в сети" : formatLastSeen(user.last_seen);
        return `<div class="friend-item"><div class="friend-avatar-wrap"><span class="avatar friend-avatar">${escapeHTML(getInitial(user.username))}</span><i class="presence-dot ${online ? "online" : ""}"></i></div><div class="friend-info"><div class="friend-name">${escapeHTML(user.username)}</div><div class="friend-online ${online ? "is-online" : ""}">${presenceText}</div></div><div class="friend-actions"><button type="button" data-open-friend="${Number(user.id)}">Написать</button><button class="remove-button" type="button" data-remove-friend="${Number(user.id)}" aria-label="Удалить друга">×</button></div></div>`;
    }).join("")}`;
    box.querySelectorAll("[data-open-friend]").forEach((button) => button.addEventListener("click", () => {
        const user = friendsCache.find((item) => Number(item.id) === Number(button.dataset.openFriend));
        if (user) openChat(user);
    }));
    box.querySelectorAll("[data-remove-friend]").forEach((button) => button.addEventListener("click", () => askRemoveFriend(Number(button.dataset.removeFriend))));
}

function askRemoveFriend(userId) {
    const user = friendsCache.find((item) => Number(item.id) === Number(userId));
    removeTargetId = userId;
    $("confirmTitle").textContent = `Удалить ${user?.username || "друга"}?`;
    openModal(confirmOverlay, $("confirmCancel"));
}

$("confirmAction")?.addEventListener("click", async () => {
    if (!removeTargetId) return;
    const id = removeTargetId;
    $("confirmAction").disabled = true;
    try {
        await IPK.api(`/api/friends/${id}`, { method: "DELETE" });
        if (Number(currentChatUser?.id) === Number(id)) closeCurrentChat();
        closeModal(confirmOverlay);
        showToast("Друг удалён", "При желании вы сможете добавить друг друга снова");
        await refreshFriends();
    } catch (error) {
        showToast("Не получилось", error.message);
    } finally {
        removeTargetId = null;
        $("confirmAction").disabled = false;
    }
});

/* Search */
function applySidebarSearch() {
    const query = searchInput.value.trim().toLocaleLowerCase("ru");
    let visible = 0;
    chatList.querySelectorAll("[data-sidebar-user]").forEach((item) => {
        const show = !query || item.textContent.toLocaleLowerCase("ru").includes(query);
        item.hidden = !show;
        if (show) visible += 1;
    });
    chatList.querySelector(".search-empty")?.remove();
    if (query && !visible && friendsCache.length) chatList.insertAdjacentHTML("beforeend", '<div class="friend-hint search-empty">Совпадений не найдено</div>');
}
searchInput?.addEventListener("input", applySidebarSearch);
document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (window.innerWidth <= 680 && appEl.classList.contains("mobile-chat-open")) closeMobileChat();
        searchInput.focus();
    }
});

/* Chat */
async function openChat(user) {
    if (!user) return;
    currentChatUser = user;
    typingInChatList.delete(Number(user.id));
    chatName.textContent = user.username || "Пользователь";
    chatAvatar.textContent = getInitial(user.username);
    updateCurrentChatStatus();
    welcomeScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    appEl.classList.add("mobile-chat-open");
    closeModal(friendOverlay);
    renderSidebarFriends(friendsCache.map((friend) => Number(friend.id) === Number(user.id) ? { ...friend, unread_count: 0 } : friend));
    recountUnread();
    loadDraft();
    await loadMessages(user.id);
    await markMessagesRead(user.id);
    messageInput.focus();
}

function closeCurrentChat() {
    emitTyping(false);
    currentChatUser = null;
    messagesRequest += 1;
    chatScreen.classList.add("hidden");
    welcomeScreen.classList.remove("hidden");
    appEl.classList.remove("mobile-chat-open");
    renderSidebarFriends(friendsCache);
}
function closeMobileChat() { appEl.classList.remove("mobile-chat-open"); }
mobileBackButton?.addEventListener("click", closeMobileChat);

function updateCurrentChatStatus() {
    if (!currentChatUser) return;
    const online = onlineUsers.has(Number(currentChatUser.id));
    chatStatus.textContent = getPresenceText(currentChatUser.id);
    chatStatus.classList.toggle("is-online", online);
    chatPresenceDot.classList.toggle("online", online);
}

async function loadMessages(userId) {
    const requestId = ++messagesRequest;
    messages.innerHTML = '<div class="message-loader"><i></i><span>Загружаем переписку</span></div>';
    try {
        const data = await IPK.api(`/api/messages/${userId}`);
        if (requestId !== messagesRequest || Number(currentChatUser?.id) !== Number(userId)) return;
        messages.innerHTML = "";
        if (!data.messages?.length) {
            messages.innerHTML = '<div class="empty-state"><div class="empty-state-icon">↗</div><h3>Начни с первого сообщения</h3><p>Этот разговор виден только вам двоим на сервере ИПК.</p></div>';
        } else {
            data.messages.forEach((message) => renderMessage(message));
        }
        scrollMessagesToBottom(false);
    } catch (error) {
        if (requestId !== messagesRequest) return;
        messages.innerHTML = `<div class="empty-state"><div class="empty-state-icon">!</div><h3>Не удалось открыть переписку</h3><p>${escapeHTML(error.message)}</p></div>`;
    }
}

function messageDateKey(value) {
    const date = parseServerDate(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU");
}

function friendlyDate(value) {
    const date = parseServerDate(value);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const key = date.toLocaleDateString("ru-RU");
    if (key === today.toLocaleDateString("ru-RU")) return "Сегодня";
    if (key === yesterday.toLocaleDateString("ru-RU")) return "Вчера";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getFileIcon(fileName) {
    const ext = (fileName || "").toLowerCase().match(/\.(\w+)$/)?.[1] || "";
    const icons = {
        pdf: "📄", doc: "📝", docx: "📝", txt: "📝", rtf: "📝",
        xls: "📊", xlsx: "📊", ppt: "📽️", pptx: "📽️",
        zip: "🗜️", rar: "🗜️", "7z": "🗜️",
        jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", webp: "🖼️", bmp: "🖼️",
        mp3: "🎵", wav: "🎵", mp4: "🎬", avi: "🎬", mov: "🎬"
    };
    return icons[ext] || "📎";
}

function isImageFile(fileName) {
    const ext = (fileName || "").toLowerCase().match(/\.(\w+)$/)?.[1] || "";
    return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext);
}

function renderMessage(message, options = {}) {
    if (!messages || !message) return;
    const id = String(message.id ?? options.localId ?? "");
    if (id && messages.querySelector(`[data-message-id="${CSS.escape(id)}"]`)) return;
    messages.querySelector(".empty-state")?.remove();
    messages.querySelector(".message-loader")?.remove();

    const lastRow = messages.querySelector(".message-row:last-of-type");
    const lastDate = lastRow?.dataset.date || "";
    const dateKey = messageDateKey(message.created_at || new Date());
    if (dateKey && dateKey !== lastDate) {
        const divider = document.createElement("div");
        divider.className = "date-divider";
        divider.textContent = friendlyDate(message.created_at || new Date());
        messages.appendChild(divider);
    }

    const own = Number(message.sender_id) === Number(currentUser?.id);
    const row = document.createElement("article");
    row.className = `message-row ${own ? "own" : "other"}${options.pending ? " pending" : ""}`;
    row.dataset.messageId = id;
    row.dataset.date = dateKey;
    const read = Number(message.is_read) === 1;
    const isFile = message.message_type === "file" || (message.file_url && !message.text);

    let contentHtml;
    if (isFile && message.file_name) {
        const icon = getFileIcon(message.file_name);
        const sizeText = formatFileSize(Number(message.file_size) || 0);
        if (options.pending) {
            // Pending file upload — show without download link
            contentHtml = `<div class="file-attachment pending"><span class="file-icon">${icon}</span><div class="file-info"><b class="file-name">${escapeHTML(message.file_name)}</b>${sizeText ? `<small class="file-size">${sizeText}</small>` : ""}</div><span class="file-status">⏳</span></div>`;
        } else {
            const isImg = isImageFile(message.file_name);
            const fileUrl = message.file_url + (message.file_url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(IPK.getToken());
            if (isImg) {
                contentHtml = `<div class="file-image"><img src="${escapeHTML(fileUrl)}" alt="${escapeHTML(message.file_name)}" loading="lazy" onerror="this.parentElement.classList.add('image-error')"></div>`;
                contentHtml += `<div class="file-attachment"><span class="file-icon">${icon}</span><div class="file-info"><a class="file-name file-download" href="${escapeHTML(fileUrl)}" download="${escapeHTML(message.file_name)}">${escapeHTML(message.file_name)}</a>${sizeText ? `<small class="file-size">${sizeText}</small>` : ""}</div><span class="file-status">⬇</span></div>`;
            } else {
                contentHtml = `<div class="file-attachment"><span class="file-icon">${icon}</span><div class="file-info"><a class="file-name file-download" href="${escapeHTML(fileUrl)}" download="${escapeHTML(message.file_name)}">${escapeHTML(message.file_name)}</a>${sizeText ? `<small class="file-size">${sizeText}</small>` : ""}</div><span class="file-status">⬇</span></div>`;
            }
        }
    } else {
        contentHtml = `<div class="message-text">${escapeHTML(message.text || "")}</div>`;
    }

    row.innerHTML = `<div class="message-bubble">${contentHtml}<div class="message-meta"><time>${escapeHTML(formatMessageTime(message.created_at || new Date()))}</time>${own ? `<span class="read-mark ${read ? "is-read" : ""}" title="${read ? "Прочитано" : "Доставлено"}">✓✓</span>` : ""}</div></div>${own && id && !options.pending ? `<button class="delete-msg" type="button" data-delete-id="${escapeHTML(id)}" aria-label="Удалить сообщение" title="Удалить">×</button>` : ""}`;
    messages.appendChild(row);

    // Bind delete button
    const delBtn = row.querySelector("[data-delete-id]");
    if (delBtn) {
        delBtn.addEventListener("click", () => deleteMessage(Number(delBtn.dataset.deleteId), delBtn));
    }
}

async function deleteMessage(messageId, btn) {
    if (!messageId) return;
    if (!confirm("Удалить сообщение для всех?")) return;
    btn.disabled = true;
    try {
        await IPK.api(`/api/messages/${messageId}`, { method: "DELETE" });
        const row = messages.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`);
        if (row) {
            row.remove();
            messages.querySelectorAll(".date-divider").forEach((div) => {
                const next = div.nextElementSibling;
                if (!next || !next.classList.contains("message-row")) div.remove();
            });
        }
        scheduleFriendsRefresh();
    } catch (error) {
        btn.disabled = false;
        showToast("Не удалось удалить", error.message);
    }
}

async function sendMessage(event) {
    event?.preventDefault();
    if (!currentChatUser || messageInput.disabled) return;
    const text = messageInput.value.trim();
    if (!text) return;
    const receiverId = Number(currentChatUser.id);
    const localId = `pending-${Date.now()}`;
    const draftBeforeSend = messageInput.value;
    renderMessage({ sender_id: currentUser.id, receiver_id: receiverId, text, created_at: new Date().toISOString(), is_read: 0 }, { pending: true, localId });
    messageInput.value = "";
    updateComposer();
    clearDraft();
    emitTyping(false);
    scrollMessagesToBottom();
    try {
        const data = await IPK.api("/api/messages", { method: "POST", body: { receiverId, text } });
        messages.querySelector(`[data-message-id="${CSS.escape(localId)}"]`)?.remove();
        renderMessage(data.message);
        scrollMessagesToBottom();
        scheduleFriendsRefresh();
    } catch (error) {
        messages.querySelector(`[data-message-id="${CSS.escape(localId)}"]`)?.remove();
        messageInput.value = draftBeforeSend;
        updateComposer();
        saveDraft();
        showToast("Сообщение не отправлено", error.message);
    }
}
messageForm?.addEventListener("submit", sendMessage);

function updateComposer() {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 132)}px`;
    sendButton.disabled = !messageInput.value.trim() || !currentChatUser;
}

messageInput?.addEventListener("input", () => {
    updateComposer();
    scheduleDraftSave();
    emitTyping(Boolean(messageInput.value.trim()));
});
messageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!sendButton.disabled) messageForm.requestSubmit();
    }
});
messageInput?.addEventListener("blur", () => emitTyping(false));

function draftKey() { return currentChatUser ? `ipk_draft_${currentChatUser.id}` : ""; }
function loadDraft() {
    messageInput.value = localStorage.getItem(draftKey()) || "";
    updateComposer();
}
function saveDraft() {
    const key = draftKey();
    if (!key) return;
    if (messageInput.value.trim()) localStorage.setItem(key, messageInput.value);
    else localStorage.removeItem(key);
}
function clearDraft() { const key = draftKey(); if (key) localStorage.removeItem(key); }
function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        saveDraft();
        draftStatus.classList.remove("hidden");
        setTimeout(() => draftStatus.classList.add("hidden"), 900);
    }, 500);
}

/* Emoji */
emojiPicker.innerHTML = emojis.map((emoji) => `<button type="button" aria-label="${emoji}">${emoji}</button>`).join("");
emojiPicker.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? messageInput.value.length;
    messageInput.value = messageInput.value.slice(0, start) + button.textContent + messageInput.value.slice(end);
    messageInput.focus();
    const cursor = start + button.textContent.length;
    messageInput.setSelectionRange(cursor, cursor);
    updateComposer();
    scheduleDraftSave();
}));
function toggleEmojiPicker(force) {
    const show = force ?? emojiPicker.classList.contains("hidden");
    emojiPicker.classList.toggle("hidden", !show);
    emojiButton.setAttribute("aria-expanded", String(show));
}
emojiButton?.addEventListener("click", () => toggleEmojiPicker());
document.addEventListener("click", (event) => {
    if (!emojiPicker.contains(event.target) && event.target !== emojiButton) toggleEmojiPicker(false);
});

/* File upload — любые типы файлов, вставка из буфера, перетаскивание */
let fileUploadInProgress = false;
let maxUploadSize = 25 * 1024 * 1024;

function formatMaxSize(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${mb % 1 === 0 ? mb : mb.toFixed(1)} МБ`;
}

async function loadUploadLimit() {
    try {
        const response = await fetch("/api/status");
        const data = await response.json();
        if (Number(data?.maxFileSize) > 0) maxUploadSize = Number(data.maxFileSize);
    } catch (error) { /* остаётся значение по умолчанию */ }
}

function clipboardFiles(dataTransfer) {
    return Array.from(dataTransfer?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => {
            const file = item.getAsFile();
            if (!file) return null;
            // Скриншот из буфера приходит без имени — даём осмысленное
            if (!file.name) {
                const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
                const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                return new File([file], `скриншот-${stamp}.${ext}`, { type: file.type });
            }
            return file;
        })
        .filter(Boolean);
}

async function uploadFile(file) {
    if (!file || !currentChatUser || fileUploadInProgress) return;
    if (!file.size) {
        showToast("Пустой файл", "Отправлять нечего");
        return;
    }
    if (file.size > maxUploadSize) {
        showToast("Файл слишком большой", `Максимум ${formatMaxSize(maxUploadSize)}`);
        return;
    }

    fileUploadInProgress = true;
    if (attachButton) attachButton.disabled = true;

    const localId = `pending-file-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const receiverId = Number(currentChatUser.id);
    const fileName = file.name || "файл";

    renderMessage({
        sender_id: currentUser.id,
        receiver_id: receiverId,
        message_type: "file",
        file_name: fileName,
        file_size: file.size,
        file_url: "",
        created_at: new Date().toISOString(),
        is_read: 0
    }, { pending: true, localId });
    scrollMessagesToBottom();

    try {
        const formData = new FormData();
        formData.append("file", file, fileName);
        formData.append("receiverId", String(receiverId));
        const response = await fetch("/api/upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${IPK.getToken()}` },
            body: formData
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.message || data?.error || "Ошибка загрузки");
        messages.querySelector(`[data-message-id="${CSS.escape(localId)}"]`)?.remove();
        renderMessage(data.message);
        scrollMessagesToBottom();
        scheduleFriendsRefresh();
    } catch (error) {
        messages.querySelector(`[data-message-id="${CSS.escape(localId)}"]`)?.remove();
        showToast("Файл не отправлен", error.message);
    } finally {
        if (attachButton) attachButton.disabled = false;
        fileUploadInProgress = false;
    }
}

attachButton?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const file of files) await uploadFile(file);
    fileInput.value = "";
});

/* Вставка из буфера: скриншоты и картинки по Ctrl+V */
async function handlePaste(event) {
    if (!currentChatUser) return;
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) await uploadFile(file);
}
messageInput?.addEventListener("paste", handlePaste);
document.addEventListener("paste", (event) => {
    if (event.target === messageInput) return; // уже обработано выше
    handlePaste(event);
});

/* Перетаскивание файлов прямо в переписку */
["dragenter", "dragover"].forEach((type) => {
    messages?.addEventListener(type, (event) => {
        if (!currentChatUser) return;
        event.preventDefault();
        messages.classList.add("drop-active");
    });
});
messages?.addEventListener("dragleave", (event) => {
    if (messages.contains(event.relatedTarget)) return;
    messages.classList.remove("drop-active");
});
messages?.addEventListener("drop", async (event) => {
    if (!currentChatUser) return;
    event.preventDefault();
    messages.classList.remove("drop-active");
    const files = Array.from(event.dataTransfer?.files || []);
    for (const file of files) await uploadFile(file);
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

loadUploadLimit();

/* In-chat search */
function toggleChatSearch(force) {
    const show = force ?? chatSearch.classList.contains("hidden");
    chatSearch.classList.toggle("hidden", !show);
    if (show) setTimeout(() => chatSearchInput.focus(), 30);
    else { chatSearchInput.value = ""; filterMessages(); }
}
chatSearchButton?.addEventListener("click", () => toggleChatSearch());
closeChatSearch?.addEventListener("click", () => toggleChatSearch(false));
chatSearchInput?.addEventListener("input", filterMessages);
function filterMessages() {
    const query = chatSearchInput.value.trim().toLocaleLowerCase("ru");
    let found = 0;
    messages.querySelectorAll(".message-row").forEach((row) => {
        const match = !query || row.textContent.toLocaleLowerCase("ru").includes(query);
        row.hidden = !match;
        if (match && query) found += 1;
    });
    chatSearchCount.textContent = query ? `${found} совп.` : "";
}
$("chatInfoButton")?.addEventListener("click", () => showToast("Приватный диалог", "Писать могут только друзья. Сквозное шифрование пока не подключено."));

/* Socket */
function connectSocket() {
    const token = IPK.getToken();
    if (!token || typeof io === "undefined") return;
    socket?.disconnect();
    socket = io({ auth: { token }, reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 5000 });

    socket.on("connect", () => {
        connectionPill.classList.add("hidden");
        socket.emit("presence:get");
        // Пока связи не было, сообщения могли прийти и остаться незамеченными:
        // сервер отправляет их только подключённым. Поэтому после подключения
        // (в том числе повторного) подтягиваем свежий список и переписку.
        refreshFriends();
        if (currentChatUser) {
            loadMessages(currentChatUser.id);
            markMessagesRead(currentChatUser.id);
        }
    });
    socket.on("disconnect", (reason) => {
        if (reason !== "io client disconnect") connectionPill.classList.remove("hidden");
    });
    socket.on("connect_error", (error) => {
        connectionPill.classList.remove("hidden");
        if (error.message === "Сессия недействительна") {
            IPK.clearSession();
            window.dispatchEvent(new CustomEvent("ipk:logout"));
        }
    });
    socket.on("presence:snapshot", ({ userIds = [] } = {}) => {
        onlineUsers.clear();
        userIds.forEach((id) => onlineUsers.add(Number(id)));
        updatePresenceUI();
    });
    socket.on("user:online", ({ userId } = {}) => {
        if (userId) {
            onlineUsers.add(Number(userId));
            typingInChatList.delete(Number(userId));
            updatePresenceUI();
        }
    });
    socket.on("user:offline", ({ userId, last_seen } = {}) => {
        if (userId) {
            onlineUsers.delete(Number(userId));
            if (last_seen) lastSeenMap.set(Number(userId), last_seen);
            updatePresenceUI();
        }
    });
    socket.on("typing:start", ({ userId, username } = {}) => {
        if (!userId) return;
        const uid = Number(userId);
        typingInChatList.add(uid);
        // Update sidebar to show "печатает…"
        if (!document.hidden) renderSidebarFriends(friendsCache);
        // If this is the current chat, show typing indicator
        if (Number(currentChatUser?.id) === uid) {
            typingText.textContent = `${username || currentChatUser.username} печатает`;
            typingRow.classList.remove("hidden");
            clearTimeout(typingRow.timer);
            typingRow.timer = setTimeout(() => typingRow.classList.add("hidden"), 3500);
        }
    });
    socket.on("typing:stop", ({ userId } = {}) => {
        if (!userId) return;
        const uid = Number(userId);
        typingInChatList.delete(uid);
        renderSidebarFriends(friendsCache);
        if (Number(currentChatUser?.id) === uid) typingRow.classList.add("hidden");
    });
    socket.on("message:new", (message) => {
        const senderId = Number(message.sender_id);
        if (Number(currentChatUser?.id) === senderId) {
            renderMessage(message);
            scrollMessagesToBottom();
            markMessagesRead(senderId);
        } else {
            const sender = friendsCache.find((friend) => Number(friend.id) === senderId);
            playNotificationSound();
            showToast(sender ? `Новое от ${sender.username}` : "Новое сообщение", message.text?.slice(0, 90) || "Открой диалог");
            scheduleFriendsRefresh();
        }
    });
    socket.on("message:sent", (message) => {
        if (Number(currentChatUser?.id) === Number(message.receiver_id)) renderMessage(message);
        scheduleFriendsRefresh();
    });
    socket.on("message:deleted", ({ id } = {}) => {
        if (!id) return;
        const row = messages.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
        if (row) {
            row.remove();
            // Remove orphan date dividers (no message-row after them)
            messages.querySelectorAll(".date-divider").forEach((div) => {
                const next = div.nextElementSibling;
                if (!next || !next.classList.contains("message-row")) div.remove();
            });
        }
        scheduleFriendsRefresh();
    });
    socket.on("messages:read", ({ userId } = {}) => {
        if (Number(currentChatUser?.id) !== Number(userId)) return;
        messages.querySelectorAll(".message-row.own .read-mark").forEach((mark) => { mark.classList.add("is-read"); mark.title = "Прочитано"; });
    });
    socket.on("friend:request", ({ username } = {}) => {
        showToast("Новая заявка в друзья", username ? `От @${username}` : "Открой раздел друзей");
        if (!friendOverlay.classList.contains("hidden")) refreshFriends();
    });
    socket.on("friend:accepted", ({ username } = {}) => {
        showToast("Заявка принята", username ? `${username} теперь в твоём круге` : "Новый друг добавлен");
        refreshFriends();
    });
    socket.on("friend:profile", () => refreshFriends());
    socket.on("friend:removed", ({ userId } = {}) => {
        if (Number(currentChatUser?.id) === Number(userId)) closeCurrentChat();
        showToast("Контакт удалён", "Пользователь больше не в твоём круге");
        refreshFriends();
    });
}

function emitTyping(active) {
    if (!socket?.connected || !currentChatUser) return;
    clearTimeout(typingStopTimer);
    socket.emit(active ? "typing:start" : "typing:stop", { receiverId: Number(currentChatUser.id) });
    if (active) typingStopTimer = setTimeout(() => emitTyping(false), 1800);
}

function updatePresenceUI() {
    updateCurrentChatStatus();
    renderSidebarFriends(friendsCache);
    if (!friendOverlay.classList.contains("hidden")) renderFriendList(friendsCache);
}

/* Раз в минуту спрашиваем у сервера актуальное присутствие. Если событие
   user:online потерялось (обрыв связи, сон приложения), статус починится сам —
   без перезагрузки страницы. */
setInterval(() => {
    if (document.hidden || !IPK.getToken()) return;
    if (socket?.connected) socket.emit("presence:get");
    if (friendsCache.length) {
        renderSidebarFriends(friendsCache);
        if (currentChatUser) updateCurrentChatStatus();
    }
}, 60000);

/* Возвращаясь во вкладку, сразу подтягиваем свежее состояние: пока вкладка была
   в фоне, соединение могло отвалиться, а сообщения — прийти мимо. */
let hiddenSince = 0;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        hiddenSince = Date.now();
        return;
    }
    if (!IPK.getToken()) return;
    if (socket && !socket.connected) socket.connect();
    if (socket?.connected) socket.emit("presence:get");
    if (Date.now() - hiddenSince > 10000) {
        refreshFriends();
        if (currentChatUser) loadMessages(currentChatUser.id);
    }
});

async function markMessagesRead(userId) {
    try {
        await IPK.api(`/api/messages/${userId}/read`, { method: "POST" });
        const friend = friendsCache.find((item) => Number(item.id) === Number(userId));
        if (friend) friend.unread_count = 0;
    } catch (error) {
        console.warn("IPK read status:", error.message);
    }
}

let refreshTimer = null;
function scheduleFriendsRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshFriends(), 300);
}

/* Dates */
function parseServerDate(value) {
    if (value instanceof Date) return value;
    if (typeof value !== "string") return new Date(value);
    let normalized = value.includes("T") ? value : value.replace(" ", "T");
    if (!normalized.endsWith("Z") && !/[+-]\d\d:\d\d$/.test(normalized)) normalized += "Z";
    return new Date(normalized);
}
function formatMessageTime(value) {
    const date = parseServerDate(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function formatSidebarTime(value) {
    if (!value) return "";
    const date = parseServerDate(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}
/**
 * Мгновенный прыжок в самый низ.
 * У списка в CSS задано scroll-behavior: smooth, поэтому обычный вызов
 * scrollTo с behavior: "auto" всё равно анимируется — и прокрутка могла
 * просто не доехать до низа (на широком экране список так и оставался
 * на самом верху, а новое сообщение было не видно). Здесь плавность
 * отключается на один вызов, чтобы прыжок был гарантированным.
 */
function jumpMessagesToBottom() {
    const previous = messages.style.scrollBehavior;
    messages.style.scrollBehavior = "auto";
    messages.scrollTop = messages.scrollHeight;
    messages.style.scrollBehavior = previous;
}

function scrollMessagesToBottom(smooth = true) {
    if (!smooth) {
        // Открытие переписки: показываем последнее сообщение сразу.
        requestAnimationFrame(() => {
            jumpMessagesToBottom();
            // Высота может вырасти после отрисовки (перенос строки, картинка).
            setTimeout(jumpMessagesToBottom, 180);
        });
        return;
    }
    requestAnimationFrame(() => {
        messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
        setTimeout(() => {
            const left = messages.scrollHeight - messages.clientHeight - messages.scrollTop;
            if (left > 4) jumpMessagesToBottom();
        }, 220);
    });
}

/* Lifecycle */
window.addEventListener("ipk:auth", async (event) => {
    currentUser = event.detail || IPK.getUser();
    currentChatUser = null;
    onlineUsers.clear();
    lastSeenMap.clear();
    typingInChatList.clear();
    unreadTotal = 0;
    originalTitle = "ИПК — свой круг";
    updateTabTitle();
    updateUserUI();
    welcomeScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");
    appEl.classList.remove("mobile-chat-open");
    await refreshFriends();
    connectSocket();
});

window.addEventListener("ipk:logout", () => {
    currentUser = null;
    currentChatUser = null;
    friendsCache = [];
    onlineUsers.clear();
    lastSeenMap.clear();
    typingInChatList.clear();
    unreadTotal = 0;
    updateTabTitle();
    messagesRequest += 1;
    socket?.disconnect();
    socket = null;
    messages.innerHTML = "";
    chatList.innerHTML = "";
    chatScreen.classList.add("hidden");
    welcomeScreen.classList.remove("hidden");
    appEl.classList.remove("mobile-chat-open");
    [themeOverlay, friendOverlay, profileOverlay, confirmOverlay].forEach(closeModal);
});

/* ============================================================
   Вступительный кадр.

   Экран «закрыт» двумя створками, по центру светится шов, затем
   створки расходятся вверх и вниз — как открываются глаза. Вся
   сцена длится около трёх секунд и полностью на CSS; здесь только
   уборка и возможность пропустить.

   Пропуск: щелчок мышью или любая клавиша.
   Если в системе включено «уменьшить движение» — не показываем вовсе.
   ============================================================ */
(function playIntro() {
    const intro = document.getElementById("intro");
    if (!intro) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        intro.remove();
        return;
    }

    document.body.classList.add("intro-on");

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("keydown", finish);
        window.removeEventListener("pointerdown", finish);
        document.body.classList.remove("intro-on");
        intro.classList.add("intro-leaving");
        window.setTimeout(() => intro.remove(), 480);
    };

    // Страховка на случай, если анимация не проиграется: убираем сцену сами.
    const timer = window.setTimeout(finish, 2700);
    window.addEventListener("keydown", finish);
    window.addEventListener("pointerdown", finish);
})();
