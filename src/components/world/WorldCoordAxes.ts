const makeAxis = (className: string, labels: readonly string[]): HTMLDivElement => {
  const axis = document.createElement('div');
  axis.className = className;
  axis.setAttribute('aria-hidden', 'true');
  for (const label of labels) {
    const tick = document.createElement('span');
    tick.textContent = label;
    axis.append(tick);
  }
  return axis;
};

/** Adds decorative longitude/latitude labels to a map stage and returns their cleanup. */
export function renderCoordAxes(stage: HTMLElement): () => void {
  const longitude = makeAxis('coord-axis-top', ['150°W', '120°W', '90°W', '60°W', '30°W', '0°', '30°E', '60°E', '90°E', '120°E', '150°E']);
  const latitude = makeAxis('coord-axis-left', ['60°N', '30°N', '0°', '30°S', '60°S']);
  stage.append(longitude, latitude);
  return () => {
    longitude.remove();
    latitude.remove();
  };
}
