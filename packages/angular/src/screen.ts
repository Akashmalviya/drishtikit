import type { ActivatedRouteSnapshot } from '@angular/router';

/**
 * The name of a screen from the router config, never from the URL.
 * For the URL `/items/42?x=1` with the route `items/:id` the name is `items/:id`.
 * The root screen is `/`.
 */
export function screenPattern(root: ActivatedRouteSnapshot): string {
  const parts: string[] = [];
  let node: ActivatedRouteSnapshot | null = root;
  while (node) {
    const path = node.routeConfig?.path;
    if (path) parts.push(path);
    node = node.firstChild;
  }
  return parts.length > 0 ? parts.join('/') : '/';
}
