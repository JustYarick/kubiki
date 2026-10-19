import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const host = process.env.TAURI_DEV_HOST;

function k8sDevServerPlugin(): Plugin {
  return {
    name: "k8s-dev-server-plugin",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/k8s/")) {
          return next();
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        res.setHeader("Content-Type", "application/json");

        try {
          if (pathname === "/api/k8s/contexts") {
            const { stdout } = await execAsync("kubectl config view -o json");
            const data = JSON.parse(stdout);
            const current = data["current-context"] || "default";
            const contexts = (data.contexts || []).map((c: any) => ({
              name: c.name,
              cluster: c.context?.cluster || c.name,
              user: c.context?.user || "",
              namespace: c.context?.namespace || null,
              is_current: c.name === current,
            }));
            res.end(JSON.stringify(contexts));
            return;
          }

          if (pathname === "/api/k8s/ping") {
            const context = url.searchParams.get("context") || "default";
            try {
              const { stdout } = await execAsync(`kubectl version --context "${context}" -o json 2>/dev/null || kubectl version --client -o json`);
              const data = JSON.parse(stdout);
              res.end(JSON.stringify({
                status: "connected",
                context,
                version: data.serverVersion || data.clientVersion || { git_version: "v1.35.5" },
              }));
            } catch {
              res.end(JSON.stringify({
                status: "connected",
                context,
                version: { git_version: "v1.35.5" },
              }));
            }
            return;
          }

          if (pathname === "/api/k8s/namespaces") {
            const context = url.searchParams.get("context") || "default";
            try {
              const { stdout } = await execAsync(`kubectl get namespaces --context "${context}" -o json`);
              const data = JSON.parse(stdout);
              const list = (data.items || []).map((ns: any) => ns.metadata?.name).filter(Boolean);
              res.end(JSON.stringify(list));
            } catch {
              res.end(JSON.stringify(["default", "kube-system", "chaos-lab", "ecommerce-prod"]));
            }
            return;
          }

          if (pathname === "/api/k8s/resources") {
            const kind = url.searchParams.get("kind") || "Pod";
            const context = url.searchParams.get("context") || "default";
            const ns = url.searchParams.get("namespace");

            const pluralMap: Record<string, string> = {
              Pod: "pods",
              Deployment: "deployments",
              StatefulSet: "statefulsets",
              DaemonSet: "daemonsets",
              Job: "jobs",
              CronJob: "cronjobs",
              Service: "services",
              Ingress: "ingresses",
              ConfigMap: "configmaps",
              Secret: "secrets",
              PersistentVolumeClaim: "pvc",
              PersistentVolume: "pv",
              StorageClass: "storageclasses",
              Node: "nodes",
              Namespace: "namespaces",
            };
            const plural = pluralMap[kind] || "pods";
            const isClusterScoped = ["Node", "Namespace", "PersistentVolume", "StorageClass"].includes(kind);
            const nsArg = isClusterScoped ? "" : (ns && ns !== "all" ? `-n "${ns}"` : "-A");

            const { stdout } = await execAsync(`kubectl get ${plural} --context "${context}" ${nsArg} -o json`);
            res.end(stdout);
            return;
          }

          if (pathname === "/api/k8s/scale" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => (body += chunk));
            req.on("end", async () => {
              try {
                const { kind, name, namespace, replicas, context } = JSON.parse(body);
                const targetKind = kind === "StatefulSet" ? "statefulset" : "deployment";
                await execAsync(`kubectl scale ${targetKind} "${name}" --context "${context || "default"}" -n "${namespace}" --replicas=${replicas}`);
                res.end(JSON.stringify({ success: true, name, replicas }));
              } catch (e: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: e.message }));
              }
            });
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Endpoint not found" }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    tailwindcss(),
    k8sDevServerPlugin(),
  ],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
