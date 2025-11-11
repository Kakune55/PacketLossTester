const statusEl = document.getElementById("ip-status");
const mapContainer = document.getElementById("ip-map");

const fieldRefs = {
    user: {
        ip: document.getElementById("user-ip"),
        location: document.getElementById("user-location"),
        as: document.getElementById("user-as"),
        isp: document.getElementById("user-isp"),
    },
    server: {
        ip: document.getElementById("server-ip"),
        location: document.getElementById("server-location"),
        as: document.getElementById("server-as"),
        isp: document.getElementById("server-isp"),
    },
};

const safeText = (value, fallback = "-") => {
    if (value === null || value === undefined) {
        return fallback;
    }
    const trimmed = String(value).trim();
    return trimmed.length === 0 ? fallback : trimmed;
};

const formatLocation = (entry) => {
    const parts = [entry.country, entry.region, entry.city].filter(Boolean);
    if (parts.length === 0) {
        return entry.success ? "未知" : safeText(entry.message, "无法获取");
    }
    return parts.join(" · ");
};

const formatAS = (entry) => {
    const name = entry.asName || "";
    const code = entry.as || "";
    if (!name && !code) {
        return entry.success ? "未知" : safeText(entry.message, "无法获取");
    }
    if (name && code && !name.includes(code)) {
        return `${name} (${code})`;
    }
    return name || code;
};

const formatISP = (entry) => {
    const isp = entry.isp || "";
    const org = entry.org || "";
    if (!isp && !org) {
        return entry.success ? "未知" : safeText(entry.message, "无法获取");
    }
    if (isp && org && isp !== org) {
        return `${isp} / ${org}`;
    }
    return isp || org;
};

const renderEntry = (slot, entry) => {
    const refs = fieldRefs[slot];
    if (!refs) {
        return;
    }
    refs.ip.textContent = safeText(entry.ip);
    refs.location.textContent = formatLocation(entry);
    refs.as.textContent = formatAS(entry);
    refs.isp.textContent = formatISP(entry);
};

const initMap = (userEntry, serverEntry) => {
    if (!window.L || !mapContainer) {
        return;
    }

    const points = [];
    const markers = [];

    const map = L.map(mapContainer, {
        worldCopyJump: true,
        scrollWheelZoom: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 10,
    }).addTo(map);

    const addMarker = (entry, label, color) => {
        const lat = entry.latitude;
        const lon = entry.longitude;
        if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
            return;
        }
        const point = [lat, lon];
        points.push(point);
        const marker = L.circleMarker(point, {
            radius: 8,
            fillColor: color,
            color,
            weight: 2,
            opacity: 0.9,
            fillOpacity: 0.6,
        }).addTo(map);
        marker.bindPopup(`<strong>${label}</strong><br>${safeText(entry.city, "未知城市")}<br>${safeText(entry.country, "未知国家")}`);
        markers.push(marker);
    };

    if (userEntry && userEntry.success) {
        addMarker(userEntry, "访问者", "#2563eb");
    }
    if (serverEntry && serverEntry.success) {
        addMarker(serverEntry, "测试服务器", "#9333ea");
    }

    if (points.length === 0) {
        map.setView([20, 0], 2);
        return;
    }

    if (points.length === 1) {
        map.setView(points[0], 5);
        markers[0].openPopup();
        return;
    }

    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    L.polyline(points, {
        color: "#2563eb",
        weight: 3,
        dashArray: "8 6",
        opacity: 0.85,
    }).addTo(map);
};

const fetchPublicIP = async () => {
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const ip = typeof data.ip === "string" ? data.ip.trim() : "";
        return ip || "";
    } catch (error) {
        console.warn("Unable to determine public IP", error);
        return "";
    }
};

const loadIpInfo = async () => {
    try {
        const publicIP = await fetchPublicIP();
        const url = new URL("/api/ipinfo", window.location.origin);
        if (publicIP) {
            url.searchParams.set("user", publicIP);
        }

        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const userEntry = payload.user ?? {};
        const serverEntry = payload.server ?? {};

        renderEntry("user", userEntry);
        renderEntry("server", serverEntry);
        initMap(userEntry, serverEntry);

        const userStatus = userEntry.success ? "已获取访客属地" : "访客属地缺失";
        const serverStatus = serverEntry.success ? "已获取服务器属地" : "服务器属地缺失";
        const sourceText = userEntry.source ? ` · 来源：${userEntry.source}` : "";
        statusEl.textContent = `状态：${userStatus} / ${serverStatus}${sourceText}`;
    } catch (error) {
        console.error("Failed to load IP info", error);
        statusEl.textContent = `状态：加载失败 · ${error.message}`;
        if (mapContainer) {
            mapContainer.innerHTML = "<p style=\"padding:16px;color:#b91c1c;\">无法加载地图数据</p>";
        }
    }
};

loadIpInfo();
