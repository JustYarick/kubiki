import json

def topology_fixture():
    lists = {'Namespace': [{'metadata': {'uid': 'ns', 'name': 'perf'}}], 'Pod': [], 'Service': [], 'Node': [], 'ReplicaSet': [], 'Deployment': [], 'ConfigMap': []}
    for index in range(8):
        lists['Node'].append({'metadata': {'uid': f'node-{index}', 'name': f'worker-{index}'}})
    for index in range(10):
        meta = {'name': f'web-{index}', 'namespace': 'perf', 'uid': f'dep-{index}'}
        lists['Deployment'].append({'metadata': meta, 'spec': {'replicas': 18}, 'status': {'readyReplicas': 18}})
        lists['ReplicaSet'].append({'metadata': {'uid': f'rs-{index}', 'name': f'web-{index}-rs', 'namespace': 'perf', 'ownerReferences': [{'uid': f'dep-{index}', 'kind': 'Deployment', 'name': f'web-{index}'}]}, 'spec': {'replicas': 18}, 'status': {'readyReplicas': 18}})
        lists['Service'].append({'metadata': {'uid': f'svc-{index}', 'name': f'service-{index}', 'namespace': 'perf'}, 'spec': {'selector': {'app': f'web-{index}'}}})
        lists['ConfigMap'].append({'metadata': {'uid': f'config-{index}', 'name': f'config-{index}', 'namespace': 'perf'}})
    for index in range(180):
        lists['Pod'].append({'metadata': {'uid': f'pod-{index}', 'name': f'pod-{index}', 'namespace': 'perf', 'labels': {'app': f'web-{index % 10}'}, 'ownerReferences': [{'uid': f'rs-{index % 10}', 'kind': 'ReplicaSet', 'name': f'web-{index % 10}-rs'}]}, 'spec': {'nodeName': f'worker-{index % 8}', 'containers': [{'name': 'app'}], 'volumes': [{'name': 'config', 'configMap': {'name': f'config-{index % 10}'}}]}, 'status': {'phase': 'Running', 'containerStatuses': [{'name': 'app', 'ready': True, 'state': {'running': {}}}]}})
    return lists

if __name__ == "__main__":
    print(json.dumps(topology_fixture()))
