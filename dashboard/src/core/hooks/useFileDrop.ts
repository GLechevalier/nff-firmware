import { useRef, useState } from 'react';

type DropProps = Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;

/**
 * File drag-and-drop for a container with many children: dragenter/dragleave
 * fire on every child boundary, so a plain boolean would flicker — a depth
 * counter keeps `dragActive` steady until the pointer truly leaves. Ignores
 * non-file drags (e.g. selected text dragged into a textarea).
 */
export function useFileDrop(onFiles: (files: File[]) => void): { dragActive: boolean; dropProps: DropProps } {
  const depth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const hasFiles = (e: React.DragEvent) => e.dataTransfer?.types.includes('Files');

  return {
    dragActive,
    dropProps: {
      onDragEnter: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragActive(true);
      },
      onDragOver: (e) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: (e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragActive(false);
      },
      onDrop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragActive(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}
