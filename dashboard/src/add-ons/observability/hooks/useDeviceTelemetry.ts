import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import type { ConsoleEntry } from '../../../components/squeletton/ConsolePanel';

let _counter = 0;
function nextId() { return `telem-${++_counter}`; }

function mapRow(row: Record<string, unknown>): ConsoleEntry[] {
  const ts = new Date(row.ts as string);
  const entries: ConsoleEntry[] = [];
  if (row.rssi !== null && row.rssi !== undefined) {
    entries.push({ id: nextId(), type: 'output', content: `RSSI: ${row.rssi} dBm`, timestamp: ts });
  }
  if (row.heap_free !== null && row.heap_free !== undefined) {
    entries.push({ id: nextId(), type: 'output', content: `Heap: ${row.heap_free} B free`, timestamp: ts });
  }
  if (row.temp_c !== null && row.temp_c !== undefined) {
    entries.push({ id: nextId(), type: 'info', content: `Temp: ${(row.temp_c as number).toFixed(1)}°C`, timestamp: ts });
  }
  if (row.packets_rx !== null && row.packets_rx !== undefined ||
      row.packets_tx !== null && row.packets_tx !== undefined) {
    entries.push({ id: nextId(), type: 'output', content: `RX: ${row.packets_rx ?? 0}  TX: ${row.packets_tx ?? 0}`, timestamp: ts });
  }
  return entries;
}

export function useDeviceTelemetry(deviceId: string) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;

  useEffect(() => {
    setEntries([]);
    setLoading(true);

    supabase
      .from('device_telemetry')
      .select('*')
      .eq('device_id', deviceId)
      .order('ts', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        const initial = (data ?? []).flatMap(row => mapRow(row as Record<string, unknown>)).reverse();
        setEntries(initial);
        setLoading(false);
      });

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`telemetry-${deviceId}-${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'device_telemetry', filter: `device_id=eq.${deviceId}` },
        payload => {
          const newEntries = mapRow(payload.new as Record<string, unknown>);
          setEntries(prev => [...prev, ...newEntries]);
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [deviceId]);

  return { entries, loading };
}
