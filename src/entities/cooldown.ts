import { Entity, Column, Index, CreateDateColumn } from "typeorm";
import BaseDocument from "../lib/handler/BaseDocument.js";

@Entity("cooldowns")
class Cooldown extends BaseDocument {
  @Column()
  cdKey: string;

  @Column({ type: "bigint" })
  time: number;

  @Column({ type: "datetime" })
  @Index()
  expireDate: Date;
}

export default Cooldown;
