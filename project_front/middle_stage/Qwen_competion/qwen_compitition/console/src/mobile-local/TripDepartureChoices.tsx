import { Button, Tag } from "antd";
import type { DepartureChoice, DepartureOrigin } from "./tripDeparture";
import type { TripStop } from "./runtime";

export default function TripDepartureChoices({ origin, choices, onChoose }: {
  origin: DepartureOrigin; choices: DepartureChoice[]; onChoose: (stop: TripStop) => void;
}) {
  return <>
    <p>{origin.label || "已获取当前位置，具体地点暂未识别"}</p>
    <p>{origin.source || origin.reason}。接下来想去哪里？</p>
    {choices.map(({ stop, distance, crowd }) => <div key={stop.crowdRegionId || stop.id}>
      <strong>{stop.name}</strong> <Tag color={crowd.color}>{crowd.text}</Tag>
      <p>直线距离约 {distance >= 1000 ? `${(distance / 1000).toFixed(1)} 公里` : `${Math.round(distance)} 米`} · {crowd.updated}</p>
      <Button size="small" aria-label={`去${stop.name}`} onClick={() => onChoose(stop)}>去这里</Button>
    </div>)}
    {!choices.length && <p>附近 8 公里内暂未找到可核实的候选景点，可以先自由走走。</p>}
    <p>人流来自现有客流服务，颜色仅表示所列数据的等级。可以自由走动，不必按行程顺序。</p>
  </>;
}
