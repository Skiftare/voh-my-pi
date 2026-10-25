import { tunnelHelp as commandHelp } from "../cli/command-help";
import Vpn from "./vpn";

export default class Tunnel extends Vpn {
	static override description = commandHelp.description;
	static override aliases = ["vpn"];
}
