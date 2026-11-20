//! Optional HTTP metadata at the real kube::Client boundary. Never reads a header or body.
use http::{Method, Uri};
use kube::{Client, client::Body};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tracing::{Instrument, Span};
static ENABLED: AtomicBool = AtomicBool::new(false);
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

#[derive(Clone, Debug)]
struct RequestMetadata {
    method: String,
    route: String,
    group: String,
    version: String,
    namespace: String,
    resource: String,
    name: String,
    subresource: String,
    operation: &'static str,
    watch: bool,
    paginated: bool,
    limit: u64,
}
fn segment(value: &str) -> String {
    if value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
    {
        value.into()
    } else {
        String::new()
    }
}
impl RequestMetadata {
    fn from_request(method: &Method, uri: &Uri) -> Self {
        let parts: Vec<_> = uri
            .path()
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let (group, version, rest, prefix) = match parts.as_slice() {
            ["api", version, rest @ ..] => {
                (String::new(), segment(version), rest, "/api/{version}")
            }
            ["apis", group, version, rest @ ..] => (
                segment(group),
                segment(version),
                rest,
                "/apis/{group}/{version}",
            ),
            ["version"] => (String::new(), String::new(), &[][..], "/version"),
            ["api"] => (String::new(), String::new(), &[][..], "/api"),
            ["apis", group] => (segment(group), String::new(), &[][..], "/apis/{group}"),
            ["apis"] => (String::new(), String::new(), &[][..], "/apis"),
            _ => (String::new(), String::new(), &[][..], "/{other}"),
        };
        let (namespace, rest) = match rest {
            ["namespaces", _, "status" | "finalize"] => (String::new(), rest.to_vec()),
            ["namespaces", namespace, resource, tail @ ..] => (
                segment(namespace),
                std::iter::once(*resource)
                    .chain(tail.iter().copied())
                    .collect::<Vec<_>>(),
            ),
            _ => (String::new(), rest.to_vec()),
        };
        let resource = rest.first().map_or(String::new(), |s| segment(s));
        let name = rest.get(1).map_or(String::new(), |s| segment(s));
        let subresource = rest.get(2).map_or(String::new(), |s| segment(s));
        // Only booleans and numeric limits survive query parsing. No selectors, cursors, commands or credentials.
        let mut watch = false;
        let mut paginated = false;
        let mut limit = 0;
        for query in uri.query().unwrap_or("").split('&') {
            if query == "watch=true" || query == "watch=1" {
                watch = true;
            }
            if query.starts_with("continue=") {
                paginated = true;
            }
            if let Some(value) = query.strip_prefix("limit=") {
                limit = value.parse::<u64>().unwrap_or(0).min(1_000_000);
            }
        }
        let operation = if watch {
            "watch"
        } else {
            match method.as_str() {
                "GET" if !resource.is_empty() && name.is_empty() => "list",
                "GET" => "get",
                "POST" => "create",
                "PUT" => "update",
                "PATCH" => "patch",
                "DELETE" if name.is_empty() => "deletecollection",
                "DELETE" => "delete",
                _ => "other",
            }
        };
        let mut route = prefix.to_string();
        if !namespace.is_empty() {
            route.push_str("/namespaces/{namespace}");
        }
        if !resource.is_empty() {
            route.push_str("/{resource}");
        }
        if !name.is_empty() {
            route.push_str("/{name}");
        }
        if !subresource.is_empty() {
            route.push_str("/{subresource}");
        }
        Self {
            method: method.as_str().into(),
            route,
            group,
            version,
            namespace,
            resource,
            name,
            subresource,
            operation,
            watch,
            paginated,
            limit,
        }
    }
}
struct Observation {
    metadata: RequestMetadata,
    context: String,
    span: Span,
    started: Instant,
    finished: bool,
}
impl Observation {
    fn start(context: String, metadata: RequestMetadata) -> Self {
        let span = tracing::debug_span!(target: "kubiki_core::cluster::http_diagnostics", "kubernetes.http");
        let result = Self {
            metadata,
            context,
            span,
            started: Instant::now(),
            finished: false,
        };
        result.event("kubernetes.request.started", 0, false, false);
        result
    }
    fn event(&self, event: &'static str, status: u16, failure: bool, cancelled: bool) {
        let data = &self.metadata;
        // All dynamic values come from the closed metadata projection above, never request Debug/Display.
        let _entered = self.span.enter();
        macro_rules! emit {
            ($level:expr) => { tracing::event!(target: "kubiki_core::cluster::http_diagnostics", $level,
                event_name = event, context = self.context.as_str(), http.request.method = data.method.as_str(),
                http.route = data.route.as_str(), http.response.status_code = status,
                k8s.api.group = data.group.as_str(), k8s.api.version = data.version.as_str(),
                namespace = data.namespace.as_str(), resource.name = data.name.as_str(),
                k8s.resource.plural = data.resource.as_str(), k8s.subresource = data.subresource.as_str(),
                k8s.operation = data.operation, k8s.watch = data.watch, k8s.list.paginated = data.paginated,
                k8s.list.limit = data.limit, duration_ms = self.started.elapsed().as_secs_f64() * 1000.0,
                error.code = if cancelled { "cancelled" } else if failure && status == 0 { "transport" } else { "none" }); }
        }
        if failure {
            emit!(tracing::Level::WARN);
        } else {
            emit!(tracing::Level::DEBUG);
        }
    }
    fn finish(&mut self, result: &Result<http::Response<Body>, kube::Error>) {
        self.finished = true;
        let status = result
            .as_ref()
            .map_or(0, |response| response.status().as_u16());
        let failure = result.is_err() || status >= 400;
        self.event(
            if failure {
                "kubernetes.request.failed"
            } else {
                "kubernetes.request.succeeded"
            },
            status,
            failure,
            false,
        );
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        if !self.finished {
            self.event("kubernetes.request.cancelled", 0, false, true);
        }
    }
}
/// Place below caches, policy and budgets: cache hits must not look like network requests.
pub fn instrument_client(client: Client, context: &str) -> Client {
    let namespace = client.default_namespace().to_owned();
    let context = context.to_owned();
    Client::new(
        tower::service_fn(move |request: http::Request<Body>| {
            let client = client.clone();
            let mut observation = ENABLED.load(Ordering::Relaxed).then(|| {
                Observation::start(
                    context.clone(),
                    RequestMetadata::from_request(request.method(), request.uri()),
                )
            });
            let span = observation
                .as_ref()
                .map(|observation| observation.span.clone())
                .unwrap_or_else(Span::none);
            async move {
                let result = client.send(request).await;
                if let Some(observation) = observation.as_mut() {
                    observation.finish(&result);
                }
                result
            }
            .instrument(span)
        }),
        namespace,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_hide_identifiers_and_query_values_but_keep_request_semantics() {
        let uri: Uri = "/apis/apps/v1/namespaces/team-a/deployments/example/scale?labelSelector=password%3Dsynthetic-private&limit=500&continue=private-cursor".parse().unwrap();
        let metadata = RequestMetadata::from_request(&Method::PATCH, &uri);
        assert_eq!(metadata.group, "apps");
        assert_eq!(metadata.version, "v1");
        assert_eq!(metadata.namespace, "team-a");
        assert_eq!(metadata.resource, "deployments");
        assert_eq!(metadata.name, "example");
        assert_eq!(metadata.subresource, "scale");
        assert_eq!(metadata.operation, "patch");
        assert_eq!(metadata.limit, 500);
        assert!(metadata.paginated);
        assert_eq!(
            metadata.route,
            "/apis/{group}/{version}/namespaces/{namespace}/{resource}/{name}/{subresource}"
        );
        assert!(!format!("{metadata:?}").contains("synthetic-private"));
        assert!(!format!("{metadata:?}").contains("private-cursor"));
    }
    #[test]
    fn discovery_namespace_subresources_and_watch_are_classified_without_guessing_urls() {
        let discovery =
            RequestMetadata::from_request(&Method::GET, &"/apis/metrics.k8s.io".parse().unwrap());
        assert_eq!(discovery.group, "metrics.k8s.io");
        assert_eq!(discovery.route, "/apis/{group}");
        let ns = RequestMetadata::from_request(
            &Method::PUT,
            &"/api/v1/namespaces/example/finalize".parse().unwrap(),
        );
        assert_eq!(ns.resource, "namespaces");
        assert_eq!(ns.name, "example");
        assert_eq!(ns.subresource, "finalize");
        assert!(ns.namespace.is_empty());
        let watch = RequestMetadata::from_request(
            &Method::GET,
            &"/api/v1/pods?watch=true&resourceVersion=sensitive-cursor"
                .parse()
                .unwrap(),
        );
        assert!(watch.watch);
        assert_eq!(watch.operation, "watch");
        assert!(!format!("{watch:?}").contains("sensitive-cursor"));
        let unknown = RequestMetadata::from_request(
            &Method::GET,
            &"/proxy/arbitrary/private-value".parse().unwrap(),
        );
        assert_eq!(unknown.route, "/{other}");
        assert!(!format!("{unknown:?}").contains("private-value"));
    }
}
