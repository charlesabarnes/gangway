import { Component } from '@angular/core';

@Component({
  selector: 'app-managed-badge',
  host: { class: 'font-mono text-xs text-muted' },
  template: `managed by config`,
})
export class ManagedBadge {}
