//! Fixed Prometheus range queries over the current Kubernetes client's service proxy.
use futures::AsyncReadExt;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryService {
    namespace: String,
    service: String,
    port: u16,
}

pub fn configured_service(context: &str) -> Result<Option<HistoryService>, String> {
    let Some(config) = std::env::var_os("KUBIKI_PROMETHEUS_SERVICES") else {
        return Ok(None);
    };
    let mut services: BTreeMap<String, HistoryService> = serde_json::from_str(
        config
            .to_str()
            .ok_or("Invalid metrics service configuration")?,
    )
    .map_err(|_| "Invalid metrics service configuration")?;
    Ok(services.remove(context))
}

impl HistoryService {
    pub async fn usage(
        &self,
        client: &kube::Client,
        namespace: Option<&str>,
        name: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<serde_json::Value>, String> {
        let label = |s: &str| {
            !s.is_empty()
                && s.len() <= 63
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        };
        if !label(&self.namespace) || !label(&self.service) || self.port == 0 || start > end {
            return Err("Invalid historical metrics service or range".into());
        }
        let ident = |s: &str| serde_json::to_string(s).expect("string serialization");
        let (cpu, memory) = if let Some(ns) = namespace {
            let selector = format!(
                "namespace={},pod={},container!=\"\",container!=\"POD\"",
                ident(ns),
                ident(name)
            );
            (
                format!("sum(rate(container_cpu_usage_seconds_total{{{selector}}}[5m]))"),
                format!("sum(container_memory_working_set_bytes{{{selector}}})"),
            )
        } else {
            let selector = format!("node={}", ident(name));
            (
                format!("sum(1 - rate(node_cpu_seconds_total{{{selector},mode=\"idle\"}}[5m]))"),
                format!(
                    "max(node_memory_MemTotal_bytes{{{selector}}} - node_memory_MemAvailable_bytes{{{selector}}})"
                ),
            )
        };
        let mut observations = BTreeMap::new();
        for (dimension, query) in [("cpu", cpu), ("memory", memory)] {
            let encoded: String = query.bytes().map(|b| format!("%{b:02X}")).collect();
            let step = ((end - start + 199) / 200).max(15);
            let path = format!(
                "/api/v1/namespaces/{}/services/{}:{}/proxy/api/v1/query_range?query={encoded}&start={start}&end={end}&step={step}",
                self.namespace, self.service, self.port
            );
            let request = http::Request::get(path)
                .body(Vec::new())
                .map_err(|_| "Invalid metrics service")?;
            let stream = client
                .request_stream(request)
                .await
                .map_err(|_| "Prometheus service proxy unavailable or denied")?;
            let mut body = Vec::new();
            stream
                .take(262145)
                .read_to_end(&mut body)
                .await
                .map_err(|_| "Cannot read historical metrics")?;
            if body.len() > 262144 {
                return Err("Historical metrics response exceeded size limit".into());
            }
            let value: serde_json::Value =
                serde_json::from_slice(&body).map_err(|_| "Invalid Prometheus response")?;
            if value["status"] != "success" || value["data"]["resultType"] != "matrix" {
                return Err("Historical metrics query failed".into());
            }
            let result = value["data"]["result"]
                .as_array()
                .ok_or("Invalid historical series")?;
            if result.len() > 1 {
                return Err("Ambiguous historical series".into());
            }
            if let Some(series) = result.first() {
                for pair in series["values"]
                    .as_array()
                    .ok_or("Invalid historical samples")?
                {
                    if let (Some(t), Some(v)) = (
                        pair[0].as_f64(),
                        pair[1].as_str().and_then(|s| s.parse::<f64>().ok()),
                    ) && v.is_finite()
                        && v >= 0.0
                        && t >= start as f64
                        && t <= end as f64
                    {
                        let point = observations.entry(t as i64).or_insert_with(|| serde_json::json!({"timestamp":chrono::DateTime::from_timestamp(t as i64,0),"usage":{"cpu":null,"memory":null}}));
                        point["usage"][dimension] = serde_json::json!(v);
                    }
                }
            }
        }
        Ok(observations.into_values().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn service_proxy_keeps_usage_dimensions_and_gaps_separate() {
        let client = kube::Client::new(
            tower::service_fn(|req: http::Request<kube::client::Body>| async move {
                assert_eq!(
                    req.uri().path(),
                    "/api/v1/namespaces/monitoring/services/prom:9090/proxy/api/v1/query_range"
                );
                let cpu = req.uri().query().unwrap().contains("%63%70%75");
                let values = if cpu {
                    serde_json::json!([[100, "0.25"], [115, "NaN"]])
                } else {
                    serde_json::json!([[115, "1024"]])
                };
                let response = serde_json::json!({"status":"success","data":{"resultType":"matrix","result":[{"values":values}]}});
                Ok::<_, std::convert::Infallible>(http::Response::new(kube::client::Body::from(
                    response.to_string().into_bytes(),
                )))
            }),
            "monitoring",
        );
        let service = HistoryService {
            namespace: "monitoring".into(),
            service: "prom".into(),
            port: 9090,
        };
        let series = service
            .usage(&client, Some("apps"), "web", 100, 120)
            .await
            .unwrap();
        assert_eq!(
            series[0]["usage"],
            serde_json::json!({"cpu":0.25,"memory":null})
        );
        assert_eq!(
            series[1]["usage"],
            serde_json::json!({"cpu":null,"memory":1024.0})
        );
    }
}
