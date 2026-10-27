import { systemTimeZone, type LogTimestampZone } from '../../core/utils/log_timestamp';
import { useUiStore } from '../../state/ui_store';
import { Select } from '../ui/Select';

export function LogTimeZoneSelect() {
  const zone = useUiStore(state => state.logsTimestampZone);
  const setZone = useUiStore(state => state.setLogsTimestampZone);
  return <Select aria-label="Log timestamp time zone" className="ide-select w-full min-w-0" value={zone} onChange={event => setZone(event.target.value as LogTimestampZone)}>
    <option value="utc">UTC</option>
    <option value="local">Local time ({systemTimeZone()})</option>
  </Select>;
}
