/**
 * 未通过筛选的块保留 DOM 与横向尺寸缓存，只移出当前阅读流。
 * content-visibility 禁止隐藏子树获得焦点；缓存容器同步 aria-hidden。
 * 不使用 hidden 属性，避免 Preflight 的 display:none 清空布局缓存。
 */
export const FILTER_VISIBILITY_CLASSES = '[&[data-filter-hidden]]:absolute [&[data-filter-hidden]]:top-0 [&[data-filter-hidden]]:inset-x-0 [&[data-filter-hidden]]:w-full [&[data-filter-hidden]]:[content-visibility:hidden]';
