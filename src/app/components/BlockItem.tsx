import React from 'react';
import type { Block } from '../../shared/types';

export interface BlockItemProps {
  block: Block;
}

export const BlockItem: React.FC<BlockItemProps> = ({ block }) => {
  return <div data-block-id={block.id}>{block.initialMarkdown}</div>;
};
