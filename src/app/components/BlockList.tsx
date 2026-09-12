import React, { forwardRef, useImperativeHandle } from 'react';
import type { Block } from '../../shared/types';
import { BlockItem } from './BlockItem';

/**
 * ADR-0005: 全部块的唯一渲染入口。
 * 搜索、定位与焦点管理必须经由此组件暴露的接口，不得绕过它直接查询 DOM。
 */
export interface BlockListHandle {
  scrollToBlock: (id: string) => void;
  focusBlock: (id: string) => void;
}

export interface BlockListProps {
  blocks: Block[];
}

export const BlockList = forwardRef<BlockListHandle, BlockListProps>(({ blocks }, ref) => {
  useImperativeHandle(ref, () => ({
    scrollToBlock: (_id: string) => {},
    focusBlock: (_id: string) => {},
  }));

  return (
    <div className="block-list">
      {blocks.map((b) => (
        <BlockItem key={b.id} block={b} />
      ))}
    </div>
  );
});

BlockList.displayName = 'BlockList';
