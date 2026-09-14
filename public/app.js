"use strict";

const authScreen = document.getElementById("authScreen");
const authTitle = document.getElementById("authTitle");
const authKicker = document.getElementById("authKicker");
const authDescription = document.getElementById("authDescription");
const authForm = document.getElementById("authForm");
const nickname = document.getElementById("nickname");
const nicknameError = document.getElementById("nicknameError");
const password = document.getElementById("password");
const passwordError = document.getElementById("passwordError");
const passwordHint = document.getElementById("passwordHint");
const passwordToggle = document.getElementById("passwordToggle");
const registerExtra = document.getElementById("registerExtra");
const strengthFill = document.getElementById("strengthFill");
const strengthText = document.getElementById("strengthText");
const authSubmit = document.getElementById("authSubmit");
const authSubmitText = document.getElementById("authSubmitText");
const switchAuth = document.getElementById("switchAuth");
const switchText = document.getElementById("switchText");
const switchAction = document.getElementById("switchAction");
const app = document.getElementById("app");
const logoutButton = document.getElementById("logoutButton");

const STORAGE = {
    token: "ipk_token",
    user: "ipk_user"
};

function saveSession(data) {
    if (!data) return;
    if (data.token) localStorage.setItem(STORAGE.token, data.token);
    if (data.user) saveUser(data.user);
}

function clearSession() {
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
}

function getToken() {
    return localStorage.getItem(STORAGE.token) || "";
}

function getUser() {
    try {
        const value = localStorage.getItem(STORAGE.user);
        return value ? JSON.parse(value) : null;
    } catch {
        localStorage.removeItem(STORAGE.user);
        return null;
    }
}

function saveUser(user) {
    if (user) localStorage.setItem(STORAGE.user, JSON.stringify(user));
}

async function api(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
    const token = getToken();
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const request = {
        method: options.method || "GET",
        headers,
        signal: options.signal || controller.signal
    };

    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) {
        if (typeof options.body === "object" && !(options.body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
            request.body = JSON.stringify(options.body);
        } else {
            request.body = options.body;
        }
    }

    try {
        const response = await fetch(url, request);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json") ? await response.json() : null;

        if (!response.ok) {
            const message = data?.message || data?.error || `Ошибка запроса (${response.status})`;
            const error = new Error(message);
            error.status = response.status;
            throw error;
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") throw new Error("Сервер не ответил вовремя. Проверь соединение.");
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

window.IPK = { getToken, getUser, saveUser, saveSession, clearSession, api };

function showAuth() {
    authScreen?.classList.remove("hidden");
    app?.classList.add("hidden");
}

function showApp() {
    authScreen?.classList.add("hidden");
    app?.classList.remove("hidden");
}

let authMode = "login";

function updateAuthMode() {
    const registering = authMode === "register";
    authKicker.textContent = registering ? "Новый участник" : "С возвращением";
    authTitle.textContent = registering ? "Создай свой аккаунт" : "Рады снова видеть";
    authDescription.textContent = registering
        ? "Пара секунд — и ты внутри своего круга."
        : "Войди, чтобы продолжить разговор.";
    authSubmitText.textContent = registering ? "Создать аккаунт" : "Войти";
    switchText.textContent = registering ? "Уже есть аккаунт?" : "Впервые здесь?";
    switchAction.textContent = registering ? "Войти" : "Создать аккаунт";
    passwordHint.textContent = registering ? "Минимум 8 символов" : "Твой секретный пароль";
    password.autocomplete = registering ? "new-password" : "current-password";
    registerExtra.classList.toggle("hidden", !registering);
    clearAuthErrors();
    updatePasswordStrength();
    nickname.focus();
}

switchAuth?.addEventListener("click", () => {
    authMode = authMode === "login" ? "register" : "login";
    authForm.reset();
    updateAuthMode();
});

passwordToggle?.addEventListener("click", () => {
    const visible = password.type === "text";
    password.type = visible ? "password" : "text";
    passwordToggle.setAttribute("aria-pressed", String(!visible));
    passwordToggle.setAttribute("aria-label", visible ? "Показать пароль" : "Скрыть пароль");
    passwordToggle.querySelector("span").textContent = visible ? "Показать" : "Скрыть";
    password.focus();
});

function updatePasswordStrength() {
    const value = password.value;
    strengthFill.style.width = "0";
    strengthFill.className = "";

    if (!value) {
        strengthText.textContent = "Придумай надёжный пароль";
        return;
    }

    let score = 0;
    if (value.length >= 8) score += 1;
    if (value.length >= 12) score += 1;
    if (/[a-zа-яё]/.test(value)) score += 1;
    if (/[A-ZА-ЯЁ]/.test(value)) score += 1;
    if (/\d/.test(value)) score += 1;
    if (/[^A-Za-zА-Яа-яЁё\d]/.test(value)) score += 1;

    if (score <= 2) {
        strengthFill.style.width = "25%";
        strengthText.textContent = "Слабый — добавь длину и цифры";
    } else if (score <= 3) {
        strengthFill.style.width = "52%";
        strengthFill.className = "medium";
        strengthText.textContent = "Неплохо, но можно надёжнее";
    } else if (score <= 5) {
        strengthFill.style.width = "78%";
        strengthFill.className = "strong";
        strengthText.textContent = "Надёжный пароль";
    } else {
        strengthFill.style.width = "100%";
        strengthFill.className = "excellent";
        strengthText.textContent = "Отличный пароль";
    }
}

password?.addEventListener("input", updatePasswordStrength);
nickname?.addEventListener("input", () => clearFieldError(nickname, nicknameError));
password?.addEventListener("input", () => clearFieldError(password, passwordError));

function clearFieldError(input, output) {
    input?.classList.remove("error");
    input?.removeAttribute("aria-invalid");
    if (output) output.textContent = "";
}

function setFieldError(input, output, message) {
    input?.classList.add("error");
    input?.setAttribute("aria-invalid", "true");
    if (output) output.textContent = message;
}

function clearAuthErrors() {
    clearFieldError(nickname, nicknameError);
    clearFieldError(password, passwordError);
}

function validateNickname() {
    const value = nickname.value.trim();
    if (!value) return setFieldError(nickname, nicknameError, "Введи никнейм"), false;
    if (value.length < 3) return setFieldError(nickname, nicknameError, "Нужно минимум 3 символа"), false;
    if (value.length > 24) return setFieldError(nickname, nicknameError, "Максимум 24 символа"), false;
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]+$/.test(value)) return setFieldError(nickname, nicknameError, "Только буквы, цифры и _"), false;
    return true;
}

function validatePassword() {
    const value = password.value;
    if (!value) return setFieldError(password, passwordError, "Введи пароль"), false;
    if (authMode === "register" && value.length < 8) return setFieldError(password, passwordError, "Нужно минимум 8 символов"), false;
    if (new TextEncoder().encode(value).length > 72) return setFieldError(password, passwordError, "Пароль слишком длинный"), false;
    return true;
}

function setAuthLoading(loading) {
    authSubmit.disabled = loading;
    authSubmit.classList.toggle("loading", loading);
    authSubmitText.textContent = loading
        ? (authMode === "login" ? "Проверяем…" : "Создаём…")
        : (authMode === "login" ? "Войти" : "Создать аккаунт");
}

authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAuthErrors();
    if (!validateNickname() || !validatePassword()) return;

    setAuthLoading(true);
    try {
        const result = await api(authMode === "login" ? "/api/login" : "/api/register", {
            method: "POST",
            body: { username: nickname.value.trim(), password: password.value }
        });
        saveSession(result);
        authForm.reset();
        updatePasswordStrength();
        showApp();
        window.dispatchEvent(new CustomEvent("ipk:auth", { detail: result.user }));
    } catch (error) {
        const target = error.message.toLowerCase().includes("парол") ? password : nickname;
        const output = target === password ? passwordError : nicknameError;
        setFieldError(target, output, error.message);
        target.focus();
    } finally {
        setAuthLoading(false);
    }
});

async function checkSession() {
    const token = getToken();
    if (!token) {
        showAuth();
        updateAuthMode();
        return;
    }

    try {
        const result = await api("/api/me");
        saveUser(result.user);
        showApp();
        window.dispatchEvent(new CustomEvent("ipk:auth", { detail: result.user }));
    } catch {
        clearSession();
        showAuth();
        updateAuthMode();
    }
}

logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
        if (getToken()) await api("/api/logout", { method: "POST" });
    } catch (error) {
        console.warn("IPK logout:", error.message);
    } finally {
        clearSession();
        window.dispatchEvent(new CustomEvent("ipk:logout"));
        app?.classList.remove("mobile-chat-open");
        showAuth();
        updateAuthMode();
        logoutButton.disabled = false;
    }
});

updateAuthMode();
checkSession();
