import { Chip, Group } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { repertoireCheckSettingsAtom } from "@/state/atoms";

const RATINGS = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
const SPEEDS = ["bullet", "blitz", "rapid", "classical"] as const;

/** Lichess rating buckets of the games used to find holes in the repertoires. */
export function RepertoireCheckRatings() {
  const [settings, setSettings] = useAtom(repertoireCheckSettingsAtom);
  return (
    <Chip.Group
      multiple
      value={settings.ratings.map(String)}
      onChange={(values) =>
        values.length > 0 &&
        setSettings({ ...settings, ratings: values.map(Number).sort((a, b) => a - b) })
      }
    >
      <Group gap={6} maw={360} justify="flex-end">
        {RATINGS.map((r) => (
          <Chip key={r} value={String(r)} size="xs">
            {r === 2500 ? "2500+" : r}
          </Chip>
        ))}
      </Group>
    </Chip.Group>
  );
}

/** Lichess speeds of the games used to find holes in the repertoires. */
export function RepertoireCheckSpeeds() {
  const { t } = useTranslation();
  const [settings, setSettings] = useAtom(repertoireCheckSettingsAtom);
  return (
    <Chip.Group
      multiple
      value={settings.speeds}
      onChange={(values) => values.length > 0 && setSettings({ ...settings, speeds: values })}
    >
      <Group gap={6} justify="flex-end">
        {SPEEDS.map((s) => (
          <Chip key={s} value={s} size="xs">
            {t(`Settings.Repertoire.Check.Speed.${s}`)}
          </Chip>
        ))}
      </Group>
    </Chip.Group>
  );
}
