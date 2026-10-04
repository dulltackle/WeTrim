import React from 'react';

/**
 * 关闭 / 清除按钮共用的叉号图标：与块提示图标同为 1.5 描边的 16 格 SVG，
 * 替代 Unicode「×」字符，避免随系统字体变形。按钮自身提供 aria-label。
 */
export const CloseIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    className="close-icon"
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
