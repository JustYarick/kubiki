//! Effective Pod requests/limits in CPU cores and memory bytes.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudget {
    pub requests: Option<f64>,
    /// None means unbounded or unknown, never a zero limit.
    pub limits: Option<f64>,
}

pub fn quantity(value: &Value) -> Option<f64> {
    let text = value.as_str()?;
    let parsed = text.parse::<f64>().ok().or_else(|| {
        [
            ("Ki", 1024.0),
            ("Mi", 1024.0_f64.powi(2)),
            ("Gi", 1024.0_f64.powi(3)),
            ("Ti", 1024.0_f64.powi(4)),
            ("Pi", 1024.0_f64.powi(5)),
            ("Ei", 1024.0_f64.powi(6)),
            ("n", 1e-9),
            ("u", 1e-6),
            ("m", 1e-3),
            ("k", 1e3),
            ("K", 1e3),
            ("M", 1e6),
            ("G", 1e9),
            ("T", 1e12),
            ("P", 1e15),
            ("E", 1e18),
        ]
        .iter()
        .find_map(|(suffix, factor)| {
            text.strip_suffix(suffix)?
                .parse::<f64>()
                .ok()
                .map(|v| v * factor)
        })
    })?;
    (parsed.is_finite() && parsed >= 0.0).then_some(parsed)
}

pub fn pod_budget(spec: &Value, dimension: &str) -> ResourceBudget {
    let budget = |kind: &str| -> Option<f64> {
        let mut unbounded = false;
        let mut read = |container: &Value| -> Option<f64> {
            let raw = container
                .pointer(&format!("/resources/{kind}/{dimension}"))
                .or_else(|| {
                    (kind == "requests")
                        .then(|| container.pointer(&format!("/resources/limits/{dimension}")))
                        .flatten()
                });
            match raw {
                Some(raw) => {
                    let value = quantity(raw)?;
                    if kind == "limits" && value == 0.0 {
                        unbounded = true;
                    }
                    Some(value)
                }
                None => {
                    if kind == "limits" {
                        unbounded = true;
                    }
                    Some(0.0)
                }
            }
        };
        let containers = spec["containers"].as_array()?;
        let mut main = 0.0;
        for container in containers {
            main += read(container)?;
        }
        let mut sidecars = 0.0;
        let mut peak: f64 = 0.0;
        for container in spec["initContainers"].as_array().into_iter().flatten() {
            let amount = read(container)?;
            if container["restartPolicy"] == "Always" {
                sidecars += amount;
                main += amount;
                peak = peak.max(sidecars);
            } else {
                peak = peak.max(sidecars + amount);
            }
        }
        let mut total = main.max(peak);
        if let Some(pod_level) = spec.pointer(&format!("/resources/{kind}/{dimension}")) {
            total = quantity(pod_level)?;
            unbounded = kind == "limits" && total == 0.0;
        }
        if kind == "limits" && unbounded {
            return None;
        }
        if let Some(overhead) = spec.pointer(&format!("/overhead/{dimension}")) {
            total += quantity(overhead)?;
        }
        Some(total)
    };
    ResourceBudget {
        requests: budget("requests"),
        limits: budget("limits"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn effective_requests_include_init_sidecars_and_overhead() {
        let spec = json!({"containers":[{"resources":{"requests":{"cpu":"100m"},"limits":{"cpu":"1"}}}],"initContainers":[{"restartPolicy":"Always","resources":{"requests":{"cpu":"200m"},"limits":{"cpu":"1"}}},{"resources":{"requests":{"cpu":"2"},"limits":{"cpu":"3"}}}],"overhead":{"cpu":"50m"}});
        let result = pod_budget(&spec, "cpu");
        assert!((result.requests.unwrap() - 2.25).abs() < 1e-9);
        assert_eq!(result.limits, Some(4.05));
        assert_eq!(quantity(&json!("512Mi")), Some(536870912.0));
        assert_eq!(quantity(&json!("100000000n")), Some(0.1));
    }
    #[test]
    fn unbounded_limits_and_invalid_quantities_are_not_zero() {
        let result = pod_budget(&json!({"containers":[{}]}), "memory");
        assert_eq!(result.requests, Some(0.0));
        assert_eq!(result.limits, None);
        assert_eq!(quantity(&json!("NaN")), None);
        assert_eq!(pod_budget(&json!({}), "cpu").requests, None);
    }
}
