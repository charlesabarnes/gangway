import { Component } from '@angular/core';

@Component({
  selector: 'app-managed-badge',
  host: { class: 'text-xs text-neutral-500' },
  template: `managed by config`,
})
export class ManagedBadge {}
