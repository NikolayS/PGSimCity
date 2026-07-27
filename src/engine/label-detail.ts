export const EXPANDED_LABEL_CAP = 2
export const READOUT_DISTANCE = 130

export const enum LabelDetail {
  Name = 0,
  Readout = 1,
  Role = 2,
}

const ATTENTION_BAND = 1_000_000_000

export function requestedLabelDetail(
  distance: number,
  hasReadout: boolean,
  selected: boolean,
  hovered: boolean,
): LabelDetail {
  if (selected || hovered) return LabelDetail.Role
  if (hasReadout && distance <= READOUT_DISTANCE) return LabelDetail.Readout
  return LabelDetail.Name
}

export function detailExpansionPriority(
  selected: boolean,
  hovered: boolean,
  centreDistanceSq: number,
): number {
  const band = selected ? 0 : hovered ? 1 : 2
  return band * ATTENTION_BAND + centreDistanceSq
}
