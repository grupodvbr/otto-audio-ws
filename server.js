const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

const PORT = process.env.PORT || 3000;
const SECRET = process.env.OTTO_AUDIO_SECRET || "otto_audio_2026";

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "OTTO AUDIO WEBSOCKET",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

const devices = new Map();
const admins = new Set();
const viewers = new Map();

function enviar(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    return false;
  }
}

function enviarAdmins(payload) {
  for (const admin of admins) {
    enviar(admin, payload);
  }
}

function agoraIso() {
  return new Date().toISOString();
}

function segundosDesde(dataIso) {
  if (!dataIso) return 999999;

  const diff = Date.now() - new Date(dataIso).getTime();

  if (!Number.isFinite(diff)) return 999999;

  return Math.max(0, Math.floor(diff / 1000));
}

function statusDevice(device) {
  const segundos = segundosDesde(device.ultimaConexao);

  if (segundos <= 8) return "online";
  if (segundos <= 25) return "instavel";

  return "offline";
}

function listaDevices() {
  return Array.from(devices.values()).map((device) => {
    const segundosSemSinal = segundosDesde(device.ultimaConexao);

    return {
      deviceId: device.deviceId,
      nome: device.nome,
      empresa: device.empresa,
      unidade: device.unidade,
      setor: device.setor,
      tipo: device.tipo,
      navegador: device.navegador,
      sistema: device.sistema,
      plataforma: device.plataforma,
      idioma: device.idioma,
      larguraTela: device.larguraTela,
      alturaTela: device.alturaTela,
      microfoneAtivo: Boolean(device.microfoneAtivo),
      ultimaConexao: device.ultimaConexao,
      primeiraConexao: device.primeiraConexao,
      ip: device.ip,
      segundosSemSinal,
      status: statusDevice(device)
    };
  });
}

function broadcastLista() {
  enviarAdmins({
    type: "devices-list",
    devices: listaDevices()
  });
}

function validarSecret(ws, msg) {
  if (!msg || msg.secret !== SECRET) {
    enviar(ws, {
      type: "error",
      message: "Secret inválido."
    });

    return false;
  }

  return true;
}

function registrarDevice(ws, msg, req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.socket.remoteAddress ||
    "";

  const existente = devices.get(msg.deviceId);

  const device = {
    ws,
    deviceId: msg.deviceId,
    nome: msg.nome || "DISPOSITIVO SEM NOME",
    empresa: msg.empresa || "",
    unidade: msg.unidade || "",
    setor: msg.setor || "",
    tipo: msg.tipo || "",
    navegador: msg.navegador || "",
    sistema: msg.sistema || "",
    plataforma: msg.plataforma || "",
    idioma: msg.idioma || "",
    larguraTela: msg.larguraTela || 0,
    alturaTela: msg.alturaTela || 0,
    microfoneAtivo: Boolean(msg.microfoneAtivo),
    primeiraConexao: existente?.primeiraConexao || agoraIso(),
    ultimaConexao: agoraIso(),
    ip
  };

  devices.set(msg.deviceId, device);

  ws._ottoTipo = "device";
  ws._ottoDeviceId = msg.deviceId;

  enviar(ws, {
    type: "device-registered",
    deviceId: msg.deviceId
  });

  broadcastLista();
}

function atualizarHeartbeatDevice(ws, msg, req) {
  if (!msg.deviceId) {
    enviar(ws, {
      type: "error",
      message: "deviceId não informado."
    });

    return;
  }

  registrarDevice(ws, msg, req);

  enviar(ws, {
    type: "heartbeat-ok",
    deviceId: msg.deviceId,
    timestamp: agoraIso()
  });
}

function registrarAdmin(ws) {
  admins.add(ws);

  ws._ottoTipo = "admin";

  enviar(ws, {
    type: "admin-registered"
  });

  enviar(ws, {
    type: "devices-list",
    devices: listaDevices()
  });
}

function pedirLista(ws) {
  enviar(ws, {
    type: "devices-list",
    devices: listaDevices()
  });
}

function ouvirDevice(ws, msg) {
  const device = devices.get(msg.deviceId);

  if (!device || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
    enviar(ws, {
      type: "listen-error",
      message: "Dispositivo offline ou indisponível."
    });

    return;
  }

  const viewerId =
    "VIEWER-" +
    Date.now() +
    "-" +
    Math.random().toString(16).slice(2, 10).toUpperCase();

  viewers.set(viewerId, {
    viewerId,
    adminWs: ws,
    deviceId: msg.deviceId,
    criadoEm: agoraIso()
  });

  enviar(ws, {
    type: "listen-started",
    viewerId,
    deviceId: msg.deviceId
  });

  enviar(device.ws, {
    type: "viewer-request",
    viewerId
  });
}

function pararListen(ws, msg) {
  const viewer = viewers.get(msg.viewerId);

  if (!viewer) return;

  const device = devices.get(viewer.deviceId);

  if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
    enviar(device.ws, {
      type: "viewer-disconnected",
      viewerId: msg.viewerId
    });
  }

  viewers.delete(msg.viewerId);
}

function encaminharOfertaDoDevice(ws, msg) {
  const viewer = viewers.get(msg.viewerId);

  if (!viewer) return;

  enviar(viewer.adminWs, {
    type: "webrtc-offer",
    viewerId: msg.viewerId,
    deviceId: viewer.deviceId,
    offer: msg.offer
  });
}

function encaminharRespostaDoAdmin(ws, msg) {
  const viewer = viewers.get(msg.viewerId);

  if (!viewer) return;

  const device = devices.get(viewer.deviceId);

  if (!device || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
    enviar(ws, {
      type: "device-offline",
      viewerId: msg.viewerId
    });

    viewers.delete(msg.viewerId);
    return;
  }

  enviar(device.ws, {
    type: "webrtc-answer",
    viewerId: msg.viewerId,
    answer: msg.answer
  });
}

function encaminharIce(ws, msg) {
  const viewer = viewers.get(msg.viewerId);

  if (!viewer) return;

  if (ws._ottoTipo === "admin") {
    const device = devices.get(viewer.deviceId);

    if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
      enviar(device.ws, {
        type: "webrtc-ice",
        viewerId: msg.viewerId,
        candidate: msg.candidate
      });
    }

    return;
  }

  if (ws._ottoTipo === "device") {
    enviar(viewer.adminWs, {
      type: "webrtc-ice",
      viewerId: msg.viewerId,
      deviceId: viewer.deviceId,
      candidate: msg.candidate
    });
  }
}

function limparConexao(ws) {
  if (ws._ottoTipo === "admin") {
    admins.delete(ws);

    for (const [viewerId, viewer] of viewers.entries()) {
      if (viewer.adminWs === ws) {
        const device = devices.get(viewer.deviceId);

        if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
          enviar(device.ws, {
            type: "viewer-disconnected",
            viewerId
          });
        }

        viewers.delete(viewerId);
      }
    }
  }

  if (ws._ottoTipo === "device") {
    const deviceId = ws._ottoDeviceId;
    const device = devices.get(deviceId);

    if (device && device.ws === ws) {
      device.ultimaConexao = agoraIso();
      device.microfoneAtivo = false;
      device.ws = null;

      devices.set(deviceId, device);
    }

    for (const [viewerId, viewer] of viewers.entries()) {
      if (viewer.deviceId === deviceId) {
        enviar(viewer.adminWs, {
          type: "device-offline",
          viewerId
        });

        viewers.delete(viewerId);
      }
    }

    broadcastLista();
  }
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg = {};

    try {
      msg = JSON.parse(data.toString());
    } catch (error) {
      enviar(ws, {
        type: "error",
        message: "JSON inválido."
      });

      return;
    }

    if (!validarSecret(ws, msg)) return;

    if (msg.type === "device-register") {
      registrarDevice(ws, msg, req);
      return;
    }

    if (msg.type === "device-heartbeat") {
      atualizarHeartbeatDevice(ws, msg, req);
      return;
    }

    if (msg.type === "admin-register") {
      registrarAdmin(ws);
      return;
    }

    if (msg.type === "devices-list-request") {
      pedirLista(ws);
      return;
    }

    if (msg.type === "listen-device") {
      ouvirDevice(ws, msg);
      return;
    }

    if (msg.type === "stop-listen") {
      pararListen(ws, msg);
      return;
    }

    if (msg.type === "webrtc-offer") {
      encaminharOfertaDoDevice(ws, msg);
      return;
    }

    if (msg.type === "webrtc-answer") {
      encaminharRespostaDoAdmin(ws, msg);
      return;
    }

    if (msg.type === "webrtc-ice") {
      encaminharIce(ws, msg);
      return;
    }

    if (msg.type === "viewer-disconnected") {
      pararListen(ws, msg);
      return;
    }

    enviar(ws, {
      type: "error",
      message: "Tipo de mensagem não reconhecido: " + msg.type
    });
  });

  ws.on("close", () => {
    limparConexao(ws);
  });

  ws.on("error", () => {
    limparConexao(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (error) {}

      continue;
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch (error) {}
  }
}, 30000);

setInterval(() => {
  broadcastLista();
}, 3000);

server.listen(PORT, () => {
  console.log("OTTO AUDIO WEBSOCKET ONLINE NA PORTA", PORT);
});
